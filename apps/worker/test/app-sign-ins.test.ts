import { ASSISTANT_ID, type Me, type NewWorkspace, type ProfileAnswer, type RoomId } from "@ember/protocol";
import {
  APP_CHANGED,
  APP_SIGN_IN_ENDED,
  APP_SIGNED_IN,
  APPS_FORBIDDEN,
  YOUR_APP_GONE,
  type AgentTools,
  type App,
  type AppAnswer,
  type AppClient,
  type AppRemoved,
  type Apps,
  type AppSignedIn,
  type AppSignInBegun,
  type YourApp,
  type YourAppSignedIn,
  type YourAppSignedOut,
} from "@ember/protocol/apps";
import { ASSISTANT_OFF } from "@ember/protocol/assistant";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scopesOf, scopesWith } from "../src/apps/scopes";
import { appTool, ownSignInEnded, ownWantsMoreAccess, signInEnded, unmadeFor, wantsMoreAccess, type GivenTool, type Unmade } from "../src/apps/tools";
import { toBase64url } from "../src/encoding";
import type { Env } from "../src/env";
import { api, cookieOf, freshDeploy, origin, shown, startDirect, workspaceSql, workspaceStub, type Session } from "./support";

// Signing in to an app whose server asks for a sign-in, with OAuth as the Model Context Protocol has
// it. A fake MCP server and its authorization server stand behind `fetch`: the server takes only the
// access token its authorization server gave last, and says where that is in its 401.

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const SONNET = "anthropic/claude-sonnet-5.5";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "nanoseconds" };

/** Where the fake server is, and its authorization server, on the Internet. */
const TRACKER = "https://mcp.tracker.example/mcp";
const AUTH = "https://auth.tracker.example";
/** Where Ember has an authorization server send a browser back, and where it serves who it is. */
const BACK = `${origin}/account/apps/signed-in`;
const CLIENT_DOCUMENT = `${origin}/oauth/client.json`;

const CLOSE_ISSUE = { name: "close_issue", description: "Closes an issue.", inputSchema: { type: "object" } };
const SEARCH_ISSUES = { name: "search_issues", description: "Finds issues by their words.", inputSchema: { type: "object", properties: { query: { type: "string" } } } };

/** A request Ember sent the fake server or its authorization server: its address, method and token, how it's held, and the form it carried, if it carried one. */
interface Asked {
  url: string;
  method: string;
  authorization: string | null;
  redirect: string;
  timed: boolean;
  form?: Record<string, string>;
  json?: Record<string, unknown>;
}

let asked: Asked[];
/** The addresses each name resolves to. */
let addresses: Record<string, string[]>;

/**
 * What the fake authorization server is: whether it reads a client from a document, registers one that
 * asks, or gives tokens only to `client`, one an administrator registered there, which proves itself
 * with its secret, and says who it is when it sends a browser back, how long its access tokens last, whether it
 * gives a token to get another with, and what it answers in place of all that, if anything, once
 * whatever that does meanwhile is done. `codes` are the ones it has sent a browser back with, each
 * with what the browser was sent to it with, and `access` and `refresh` the tokens it gave last, the
 * `issued`th, which allow the scopes of `scope`, which it says with them unless `saysScope` is off. `tools` are what the fake server lists, and `listing`
 * what happens while it lists them, if anything, once it has decided what to answer. `needs` is the
 * scope the fake server asks of whoever sends it a `method`, if it asks one. `revokes` is whether the
 * authorization server takes tokens back, which it answers with `revoked` in place of doing so, if
 * that answers anything. With `keepsOthers`, the tokens it gives a new sign-in leave the ones it gave
 * before good, as a service's do for each account that signs in: `others` are those, by their access
 * tokens.
 */
interface AuthorizationServer {
  readsDocuments: boolean;
  registers: boolean;
  client: { id: string; secret: string } | null;
  saysIssuer: boolean;
  expiresIn: number | undefined;
  refreshes: boolean;
  metadata: (metadata: Record<string, unknown>) => Record<string, unknown> | null;
  resource: (resource: Record<string, unknown>) => Record<string, unknown> | null;
  token: (form: Record<string, string>) => Response | null | Promise<Response | null>;
  codes: Map<string, URLSearchParams>;
  issued: number;
  access: string | null;
  refresh: string | null;
  scope: string | undefined;
  saysScope: boolean;
  tools: unknown[];
  listing: (() => Promise<unknown>) | undefined;
  needs: { method: string; scope: string } | null;
  revokes: boolean;
  revoked: () => Response | null;
  keepsOthers: boolean;
  others: Map<string, { refresh: string | null; scope: string | undefined }>;
}
let auth: AuthorizationServer;

const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

/** The S256 challenge of a PKCE `verifier`. */
const challengeOf = async (verifier: string) => toBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))).replace(/=+$/, "");

/** The tokens the fake authorization server gives next, which end the ones it gave last, unless they're for a sign-in `beside` it and it keeps the others'. */
function nextTokens(scope: string | undefined, beside = false): Response {
  if (beside && auth.keepsOthers && auth.access !== null) auth.others.set(auth.access, { refresh: auth.refresh, scope: auth.scope });
  auth.issued += 1;
  auth.access = `access-${auth.issued}`;
  auth.refresh = auth.refreshes ? `refresh-${auth.issued}` : null;
  if (scope !== undefined) auth.scope = scope;
  return Response.json({
    access_token: auth.access,
    token_type: "Bearer",
    ...(auth.expiresIn !== undefined && { expires_in: auth.expiresIn }),
    ...(auth.refresh !== null && { refresh_token: auth.refresh }),
    ...(scope !== undefined && auth.saysScope && { scope }),
  });
}

/** Who a request to the token endpoint says it's from: the client ID and secret of its Basic authorization, or else of its form. */
function clientOf({ form = {}, authorization }: Asked): { id: string | undefined; secret: string | undefined } {
  if (!authorization?.startsWith("Basic ")) return { id: form.client_id, secret: form.client_secret };
  const [id, secret] = atob(authorization.slice("Basic ".length)).split(":").map(decodeURIComponent);
  return { id, secret };
}

/**
 * What the fake authorization server answers at its token endpoint: tokens for a code it sent a browser
 * back with, proven with its verifier, or for the token it gave last to get another with, to the client
 * an administrator registered there alone, if one did.
 */
async function tokensFor(sent: Asked): Promise<Response> {
  const form = sent.form ?? {};
  const instead = await auth.token(form);
  if (instead) return instead;
  const client = clientOf(sent);
  if (auth.client && (client.id !== auth.client.id || client.secret !== auth.client.secret)) return oauthError("invalid_client", 401);
  if (form.grant_type === "refresh_token" && form.refresh_token !== auth.refresh) return othersNextTokens(form.refresh_token);
  if (form.grant_type === "refresh_token") return auth.refresh !== null ? nextTokens(undefined) : oauthError("invalid_grant");
  const began = auth.codes.get(form.code ?? "");
  auth.codes.delete(form.code ?? "");
  if (!began || form.grant_type !== "authorization_code") return oauthError("invalid_grant");
  const proven = began.get("code_challenge") === (await challengeOf(form.code_verifier ?? ""));
  const same = form.redirect_uri === began.get("redirect_uri") && client.id === began.get("client_id") && form.resource === began.get("resource");
  return proven && same ? nextTokens(began.get("scope") ?? undefined, true) : oauthError("invalid_grant");
}

/** The tokens the fake authorization server gives in place of another sign-in's, the one `refresh` gets the next of, which end those. */
function othersNextTokens(refresh: string | undefined): Response {
  const [access, other] = [...auth.others].find(([, other]) => other.refresh !== null && other.refresh === refresh) ?? [];
  if (access === undefined || !other) return oauthError("invalid_grant");
  auth.others.delete(access);
  auth.issued += 1;
  auth.others.set(`access-${auth.issued}`, { refresh: `refresh-${auth.issued}`, scope: other.scope });
  return Response.json({ access_token: `access-${auth.issued}`, token_type: "Bearer", expires_in: auth.expiresIn, refresh_token: `refresh-${auth.issued}` });
}

/** What the fake authorization server, or the fake server's own description of its sign-in, answers a request at `url`. */
async function signInAnswer(url: URL, request: Request, sent: Asked): Promise<Response> {
  if (url.origin === new URL(TRACKER).origin && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    const resource = auth.resource({ resource: TRACKER, authorization_servers: [AUTH], scopes_supported: ["issues"] });
    return resource ? Response.json(resource) : new Response(null, { status: 404 });
  }
  if (url.origin !== AUTH) return new Response(null, { status: 404 });
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    const metadata = auth.metadata({
      issuer: AUTH,
      authorization_endpoint: `${AUTH}/authorize`,
      token_endpoint: `${AUTH}/token`,
      ...(auth.registers && { registration_endpoint: `${AUTH}/register` }),
      ...(auth.revokes && { revocation_endpoint: `${AUTH}/revoke` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: auth.client ? ["client_secret_basic", "none"] : ["none"],
      ...(auth.readsDocuments && { client_id_metadata_document_supported: true }),
      ...(auth.saysIssuer && { authorization_response_iss_parameter_supported: true }),
    });
    return metadata ? Response.json(metadata) : new Response(null, { status: 404 });
  }
  if (url.pathname === "/register" && request.method === "POST" && auth.registers) return Response.json({ ...sent.json, client_id: "ember-at-tracker" }, { status: 201 });
  if (url.pathname === "/token" && request.method === "POST") return tokensFor(sent);
  if (url.pathname === "/revoke" && request.method === "POST" && auth.revokes) return revocationOf(sent);
  return new Response(null, { status: 404 });
}

/** What the fake authorization server answers at its revocation endpoint: it takes back the token it's sent, from the client it's for, which is no good from then on. */
function revocationOf(sent: Asked): Response {
  const instead = auth.revoked();
  if (instead) return instead;
  const client = clientOf(sent);
  if (auth.client && (client.id !== auth.client.id || client.secret !== auth.client.secret)) return oauthError("invalid_client", 401);
  if (sent.form?.token === auth.refresh) auth.refresh = null;
  if (sent.form?.token === auth.access) auth.access = null;
  for (const [access, other] of auth.others) {
    if (sent.form?.token === other.refresh) other.refresh = null;
    if (sent.form?.token === access) auth.others.delete(access);
  }
  return new Response(null, { status: 200 });
}

/** The fake server's answer to a JSON-RPC `message`, as Streamable HTTP has it. */
function answerTo(message: { id?: number; method?: string; params?: { protocolVersion?: string } }): Response {
  const result = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") return result({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Tracker", version: "1.2.3" } });
  if (message.method === "tools/list") return result({ tools: auth.tools });
  if (message.method === "tools/call") return result({ content: [{ type: "text", text: "Done." }] });
  if (message.id === undefined) return new Response(null, { status: 202 });
  return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
}

const CHALLENGE = `Bearer resource_metadata="https://mcp.tracker.example/.well-known/oauth-protected-resource/mcp", scope="issues"`;
/** What the fake server refuses a request with for want of `scope`. */
const wants = (scope: string) => new Response("Forbidden", { status: 403, headers: { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}"` } });

beforeEach(async () => {
  await freshDeploy();
  asked = [];
  addresses = { "mcp.tracker.example": ["93.184.216.34"], "auth.tracker.example": ["93.184.216.35"], "auth.internal.example": ["10.0.0.5"] };
  auth = {
    readsDocuments: false,
    registers: true,
    client: null,
    saysIssuer: false,
    expiresIn: 3600,
    refreshes: true,
    metadata: (metadata) => metadata,
    resource: (resource) => resource,
    token: () => null,
    codes: new Map(),
    issued: 0,
    access: null,
    refresh: null,
    scope: undefined,
    saysScope: true,
    tools: [SEARCH_ISSUES],
    listing: undefined,
    needs: null,
    revokes: false,
    revoked: () => null,
    keepsOthers: false,
    others: new Map(),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") {
      const found = url.searchParams.get("type") === "A" ? (addresses[url.searchParams.get("name")!] ?? []) : [];
      return Response.json({ Status: 0, Answer: found.map((data) => ({ type: 1, data })) });
    }
    // Turning Ember AI on asks its model a test question.
    if (!url.hostname.endsWith(".example")) {
      return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "Hello!" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } });
    }
    const type = request.headers.get("Content-Type") ?? "";
    const sent: Asked = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("Authorization"),
      redirect: init?.redirect ?? "follow",
      timed: init?.signal instanceof AbortSignal,
      ...(type.includes("form") && { form: Object.fromEntries([...(await request.formData())].map(([name, value]) => [name, String(value)])) }),
      ...(type.includes("json") && { json: (await request.json()) as Record<string, unknown> }),
    };
    asked.push(sent);
    if (request.url !== TRACKER) return signInAnswer(url, request, sent);
    const other = auth.others.get(sent.authorization?.replace(/^Bearer /, "") ?? "");
    if ((auth.access === null || sent.authorization !== `Bearer ${auth.access}`) && !other) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": CHALLENGE } });
    if (!sent.json) return new Response(null, { status: 405 });
    const allowed = ((other ?? auth).scope ?? "").split(" ");
    if (auth.needs && sent.json.method === auth.needs.method && !auth.needs.scope.split(" ").every((scope) => allowed.includes(scope))) return wants(auth.needs.scope);
    const answer = answerTo(sent.json);
    if (sent.json.method !== "tools/list") return answer;
    const meanwhile = auth.listing;
    auth.listing = undefined;
    await meanwhile?.();
    return answer;
  });
});
afterEach(() => vi.restoreAllMocks());

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Sets Ember up with Ada as its administrator, signed in, and Ember AI on. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const administrator = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const on = await api("/api/account/assistant", { method: "PUT", headers: as(administrator), body: JSON.stringify({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: SONNET }) });
  expect(on.status, await on.clone().text()).toBe(200);
  return administrator;
}

/** Grace joins with the join link, as a member, signed in. */
const joinAsGrace = () => joinAs(grace);

/** `person` joins with the join link, as a member, signed in. */
async function joinAs(person: typeof grace): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(person) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

const TRACKER_APP = { name: "Tracker", url: TRACKER };

const connect = (session: Session | null, body: unknown) => api("/api/account/apps", { method: "POST", headers: as(session), body: JSON.stringify(body) });
const begin = (session: Session | null, body: unknown = TRACKER_APP) => api("/api/account/app-sign-ins", { method: "POST", headers: as(session), body: JSON.stringify(body) });
const beginAgain = (session: Session | null, id: string, client?: AppClient) =>
  api(`/api/account/apps/${id}/sign-in`, { method: "POST", headers: as(session), ...(client && { body: JSON.stringify(client) }) });
const finish = (session: Session | null, body: unknown) => api("/api/account/app-sign-ins/finish", { method: "POST", headers: as(session), body: JSON.stringify(body) });
const show = (session: Session | null, id: string) => api(`/api/account/apps/${id}`, { headers: as(session) });
const change = (session: Session | null, id: string, body: unknown) => api(`/api/account/apps/${id}`, { method: "PATCH", headers: as(session), body: JSON.stringify(body) });
const readAgain = (session: Session | null, id: string) => api(`/api/account/apps/${id}/tools`, { method: "POST", headers: as(session) });
const disconnect = (session: Session | null, id: string) => api(`/api/account/apps/${id}`, { method: "DELETE", headers: as(session) });

/** What `response` refuses with, which it answers with `status`. */
async function refusalOf(response: Response, status = 422): Promise<{ error: string; field?: string; signIn?: boolean; client?: boolean }> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}

/** Where `response`, the answer to beginning a sign-in, sends the browser. */
async function sentTo(response: Response): Promise<URL> {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return new URL(((await response.json()) as AppSignInBegun).authorizationUrl);
}

/** Signs in at the fake authorization server, where the browser was sent to it at `authorizationUrl`: what it comes back to Ember with. */
function comeBack(authorizationUrl: URL): { state: string; code: string; iss?: string } {
  const code = `code-${auth.codes.size + 1}-${crypto.randomUUID()}`;
  auth.codes.set(code, authorizationUrl.searchParams);
  return { state: authorizationUrl.searchParams.get("state")!, code, ...(auth.saysIssuer && { iss: AUTH }) };
}

/** The app `response`, the answer to finishing a sign-in, answers, which it answers with `status`. */
async function signedInBy(response: Response, status = 201): Promise<App> {
  expect(response.status, await response.clone().text()).toBe(status);
  const { app, again } = (await response.json()) as AppSignedIn;
  expect(again).toBe(status === 200);
  return app;
}

/** Signs in again to the connected app `id` as `administrator`. */
const signInAgain = async (administrator: Session, id: string) => signedInBy(await finish(administrator, comeBack(await sentTo(await beginAgain(administrator, id)))), 200);

/** What @ember's page offers of the connected apps' tools now. */
const offered = async (administrator: Session) => ((await (await api(`/api/account/agents/${ASSISTANT_ID}/tools`, { headers: as(administrator) })).json()) as AgentTools).apps;

/** Has every tool @ember's page offers now be picked for it, or none. */
async function pick(administrator: Session, every: boolean): Promise<void> {
  const tools = every ? (await offered(administrator)).flatMap(({ id, tools }) => tools.map(({ name, fingerprint }) => ({ appId: id, name, fingerprint }))) : [];
  const saved = await api(`/api/account/agents/${ASSISTANT_ID}/tools`, { method: "PUT", headers: as(administrator), body: JSON.stringify({ tools }) });
  expect(saved.status, await saved.clone().text()).toBe(200);
}

/** Connects the fake server by signing in to it as `administrator`. */
const signIn = async (administrator: Session) => signedInBy(await finish(administrator, comeBack(await sentTo(await begin(administrator)))));

const appOf = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as AppAnswer).app;
};

/** What a service that doesn't come to know Ember by itself is refused with, which has the form ask for a client ID. */
const UNREGISTERED = {
  error: "mcp.tracker.example has a sign-in, but doesn't let Ember register itself for it. Register Ember there yourself and give its client ID, or give a token, if it has one.",
  field: "token",
  client: true,
};

/** Where a call goes as nobody: its tool isn't whoever asked's own. */
const NOWHERE = { roomId: "0nowhere", askerId: "0nobody" };

/** The tool the fake server lists, picked for @ember, as its model is given it: calling it asks the server, as a call someone allowed does. */
async function pickedTool(administrator: Session, app: App) {
  await pick(administrator, true);
  const { name, fingerprint } = (await offered(administrator))[0]!.tools[0]!;
  return appTool(env as unknown as Env, ASSISTANT_ID, { appId: app.id, appName: app.name, name, fingerprint, as: name }, NOWHERE);
}

/** What removing a signed-in app answers of its sign-in: whether its service took it back. */
async function removed(response: Response): Promise<AppRemoved> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** The requests Ember sent the fake authorization server's revocation endpoint: what each carried, and how it was held. */
const revocations = () => asked.filter(({ url }) => url === `${AUTH}/revoke`).map(({ form, authorization, redirect, timed }) => ({ form, authorization, redirect, timed }));

/** Waits until Ember has no app connected, as once one that's being removed is gone. */
const noApps = () => vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM apps")).toEqual([{ n: 0 }]));

/**
 * Removes the app `id` as `administrator` while Ember asks the fake authorization server for its
 * sign-in's next token, as `asks` has it do, which it's answered once the app is gone, with `given`,
 * the tokens it was given before that, if it was: what `asks` came to, and what removing the app answered.
 */
async function removedWhileAsking<T>(administrator: Session, id: string, asks: () => Promise<T>, given: () => Response | null = () => null): Promise<[T, Response]> {
  let asking = false;
  auth.token = async () => {
    const tokens = given();
    asking = true;
    await noApps();
    return tokens;
  };
  const asked = asks();
  await vi.waitFor(() => expect(asking).toBe(true));
  return Promise.all([asked, disconnect(administrator, id)]);
}

/** The requests Ember sent the fake authorization server's token endpoint. */
const tokenRequests = () => asked.filter(({ url }) => url === `${AUTH}/token`).map(({ form }) => form!);

describe("Signing in to an app", () => {
  it("says that a server which asks for a sign-in can be signed in to", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await refusalOf(await connect(administrator, TRACKER_APP))).toEqual({
      error: "mcp.tracker.example asks for a sign-in. Sign in to it, or give a token for it, if it has one.",
      field: "token",
      signIn: true,
    });
  });

  it("begins by finding the server's authorization server and registering there, and answers where to send the browser, which proves itself with PKCE", async () => {
    const administrator = await setUp();
    const to = await sentTo(await begin(administrator, { name: " Tracker ", url: ` ${TRACKER} ` }));

    expect(`${to.origin}${to.pathname}`).toBe(`${AUTH}/authorize`);
    expect(Object.fromEntries(to.searchParams)).toEqual({
      response_type: "code",
      client_id: "ember-at-tracker",
      code_challenge: expect.stringMatching(/^[\w-]{43}$/) as string,
      code_challenge_method: "S256",
      redirect_uri: BACK,
      state: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      scope: "issues",
      resource: TRACKER,
    });
    // It asked the server, which said where its sign-in is described, then that, the authorization server, and to be registered there.
    expect(asked.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${TRACKER}`,
      "GET https://mcp.tracker.example/.well-known/oauth-protected-resource/mcp",
      `GET ${AUTH}/.well-known/oauth-authorization-server`,
      `POST ${AUTH}/register`,
    ]);
    expect(asked[3]!.json).toMatchObject({ client_name: "Ember", client_uri: origin, redirect_uris: [BACK], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
    // No request follows a redirect, and each can be stopped at the deadline.
    expect(asked.every(({ redirect, timed }) => redirect === "manual" && timed)).toBe(true);
    // Nothing is connected yet, and what's kept of the sign-in is sealed.
    expect(await workspaceSql("SELECT count(*) AS n FROM apps")).toEqual([{ n: 0 }]);
    const [pending] = (await workspaceSql("SELECT user_id, app_id, name, url, sign_in FROM app_sign_ins")) as [{ sign_in: string }];
    expect(pending).toMatchObject({ user_id: administrator.user.id, app_id: null, name: "Tracker", url: TRACKER });
    expect(pending.sign_in).toMatch(/^v1\./);
    expect(pending.sign_in).not.toContain("ember-at-tracker");
  });

  it("finishes by exchanging the code with its verifier, reads the server's tools signed in, and connects the app, which its page shows", async () => {
    const administrator = await setUp();
    const back = comeBack(await sentTo(await begin(administrator)));
    asked = [];
    const app = await signedInBy(await finish(administrator, back));

    expect(app).toMatchObject({ name: "Tracker", url: TRACKER, hasToken: false, tools: [{ name: "search_issues" }], connectedBy: administrator.user });
    expect(app.signIn).toEqual({ by: administrator.user, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string, ended: false, clientId: null, wantsScope: null });
    expect(await appOf(await show(administrator, app.id))).toEqual(app);
    expect(tokenRequests()).toEqual([
      { grant_type: "authorization_code", code: back.code, code_verifier: expect.stringMatching(/^[\w.~-]{43,128}$/) as string, redirect_uri: BACK, client_id: "ember-at-tracker", resource: TRACKER },
    ]);
    expect(asked.filter(({ url }) => url === TRACKER).every(({ authorization }) => authorization === "Bearer access-1")).toBe(true);
    expect(asked.every(({ redirect, timed }) => redirect === "manual" && timed)).toBe(true);
    // The tokens are kept sealed, for this app, and the sign-in under way is gone.
    const [{ token, sign_in: kept }] = (await workspaceSql("SELECT token, sign_in FROM apps")) as [{ token: string | null; sign_in: string }];
    expect(token).toBeNull();
    expect(kept).toMatch(/^v1\./);
    expect(kept).not.toContain("access-1");
    expect(await workspaceSql("SELECT count(*) AS n FROM app_sign_ins")).toEqual([{ n: 0 }]);
    // It's finished once.
    expect(await refusalOf(await finish(administrator, back))).toEqual({ error: APP_SIGN_IN_ENDED });
  });

  it("is finished only by the administrator who began it, and within ten minutes", async () => {
    const administrator = await setUp();
    const other = await joinAsGrace();
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", other.user.id);
    const back = comeBack(await sentTo(await begin(administrator)));

    expect(await refusalOf(await finish(other, back))).toEqual({ error: APP_SIGN_IN_ENDED });
    expect(await refusalOf(await finish(administrator, { ...back, state: "0".repeat(64) }))).toEqual({ error: APP_SIGN_IN_ENDED });
    expect(await refusalOf(await finish(administrator, { state: back.state }))).toEqual({ error: APP_SIGN_IN_ENDED });
    expect(await refusalOf(await finish(administrator, { ...back, code: "c".repeat(4097) }))).toEqual({ error: APP_SIGN_IN_ENDED });
    const [{ expires_at: expiresAt }] = (await workspaceSql("SELECT expires_at FROM app_sign_ins")) as [{ expires_at: string }];
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    await workspaceSql("UPDATE app_sign_ins SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
    expect(await refusalOf(await finish(administrator, back))).toEqual({ error: APP_SIGN_IN_ENDED });
    expect(tokenRequests()).toEqual([]);
    expect(await workspaceSql("SELECT count(*) AS n FROM apps")).toEqual([{ n: 0 }]);
  });

  it("is only an administrator's to begin or finish, while Ember AI is on", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const back = comeBack(await sentTo(await begin(administrator)));
    asked = [];

    expect(await refusalOf(await begin(null), 401)).toEqual({ error: "Not signed in" });
    expect(await refusalOf(await begin(member), 403)).toEqual({ error: APPS_FORBIDDEN });
    expect(await refusalOf(await finish(null, back), 401)).toEqual({ error: "Not signed in" });
    // A sign-in is only its own person's to finish, and is still theirs to once someone else has tried.
    expect(await refusalOf(await finish(member, back))).toEqual({ error: APP_SIGN_IN_ENDED });
    expect(await workspaceSql("SELECT count(*) AS n FROM app_sign_ins")).toEqual([{ n: 1 }]);
    expect(await refusalOf(await beginAgain(member, "0mgk3x2a9b4c5e"), 403)).toEqual({ error: APPS_FORBIDDEN });
    expect(await refusalOf(await beginAgain(administrator, "0mgk3x2a9b4c5e"), 404)).toEqual({ error: "Not found" });

    expect((await api("/api/account/assistant", { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    expect(await refusalOf(await begin(administrator), 409)).toEqual({ error: ASSISTANT_OFF });
    expect(await refusalOf(await finish(administrator, back), 409)).toEqual({ error: ASSISTANT_OFF });
    expect(asked).toEqual([]);
  });

  it("names itself by its client document to an authorization server that reads one, and serves the document", async () => {
    const administrator = await setUp();
    auth.readsDocuments = true;
    const to = await sentTo(await begin(administrator));

    expect(to.searchParams.get("client_id")).toBe(CLIENT_DOCUMENT);
    expect(asked.some(({ url }) => url === `${AUTH}/register`)).toBe(false);
    const app = await signedInBy(await finish(administrator, comeBack(to)));
    expect(app.signIn?.ended).toBe(false);
    expect(tokenRequests()[0]).toMatchObject({ client_id: CLIENT_DOCUMENT });

    // Anyone may read it, signed in or not, whatever their browser.
    const document = await api("/oauth/client.json", { headers: { "User-Agent": "an-authorization-server/1.0" } });
    expect(document.status).toBe(200);
    expect(await document.json()).toEqual({
      client_id: CLIENT_DOCUMENT,
      client_name: "Ember",
      client_uri: origin,
      redirect_uris: [BACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("checks who an authorization server says it is when it sends the browser back, where it says", async () => {
    const administrator = await setUp();
    auth.saysIssuer = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const another = "The sign-in mcp.tracker.example names says it's another service's, so Ember won't use it.";

    const unsaid = comeBack(await sentTo(await begin(administrator)));
    expect(await refusalOf(await finish(administrator, { state: unsaid.state, code: unsaid.code }))).toEqual({ error: another });
    const wrong = comeBack(await sentTo(await begin(administrator)));
    expect(await refusalOf(await finish(administrator, { ...wrong, iss: "https://auth.elsewhere.example" }))).toEqual({ error: another });
    expect(tokenRequests()).toEqual([]);

    expect((await signIn(administrator)).signIn?.ended).toBe(false);
  });

  it("gets another access token as the last one ends, with the token it keeps for that, which it sends once", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    asked = [];
    // The next token lasts, so whatever asks after it finds it good.
    auth.token = () => ((auth.expiresIn = 3600), null);

    const read = await Promise.all([readAgain(administrator, app.id), readAgain(administrator, app.id), readAgain(administrator, app.id)]);
    expect(read.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(tokenRequests()).toEqual([{ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "ember-at-tracker", resource: TRACKER }]);
    expect(asked.filter(({ url }) => url === TRACKER).every(({ authorization }) => authorization === "Bearer access-2")).toBe(true);
    expect(asked.every(({ redirect, timed }) => redirect === "manual" && timed)).toBe(true);

    // That token is good for an hour, so nothing asks for another.
    auth.token = () => null;
    asked = [];
    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(tokenRequests()).toEqual([]);
    expect((await appOf(await show(administrator, app.id))).signIn?.ended).toBe(false);
  });

  it("sends the token it was given last to get the next one", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    asked = [];

    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(tokenRequests().map(({ refresh_token }) => refresh_token)).toEqual(["refresh-1", "refresh-2"]);
    expect(auth.access).toBe("access-3");
    expect((await appOf(await show(administrator, app.id))).signIn?.ended).toBe(false);
  });

  it("ends once the authorization server won't give another token: the app's page says so, and its server isn't asked until an administrator signs in again", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    await pick(administrator, true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.token = () => oauthError("invalid_grant");
    asked = [];

    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: signInEnded("Tracker") });
    expect(tokenRequests()).toHaveLength(1);
    expect(asked.some(({ url }) => url === TRACKER)).toBe(false);
    expect((await appOf(await show(administrator, app.id))).signIn).toEqual({ ...app.signIn, ended: true });
    expect(((await (await api("/api/account/apps", { headers: as(administrator) })).json()) as Apps).apps).toMatchObject([{ id: app.id, signInEnded: true }]);
    expect(await workspaceSql("SELECT sign_in FROM apps")).toEqual([{ sign_in: null }]);
    // Nothing is asked for it any more.
    asked = [];
    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: signInEnded("Tracker") });
    expect(asked).toEqual([]);

    // Signing in again keeps the app, and the tools picked from it.
    auth.token = () => null;
    auth.expiresIn = 3600;
    const to = await sentTo(await beginAgain(administrator, app.id));
    expect(await workspaceSql("SELECT app_id, name, url FROM app_sign_ins")).toEqual([{ app_id: app.id, name: "Tracker", url: TRACKER }]);
    const again = await signedInBy(await finish(administrator, comeBack(to)), 200);
    expect(again).toMatchObject({ id: app.id, name: "Tracker", hasToken: false, tools: [{ name: "search_issues" }], setAside: [] });
    expect(again.signIn).toMatchObject({ by: administrator.user, ended: false });
    expect(((await (await api("/api/account/apps", { headers: as(administrator) })).json()) as Apps).apps).toMatchObject([{ id: app.id, signInEnded: false }]);
    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect((await offered(administrator))[0]!.tools.map(({ picked }) => picked)).toEqual([true]);
  });

  it("ends with its access token when the authorization server gave none to get another with", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    auth.refreshes = false;
    const app = await signIn(administrator);
    asked = [];

    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: signInEnded("Tracker") });
    expect(asked).toEqual([]);
    expect((await appOf(await show(administrator, app.id))).signIn?.ended).toBe(true);
  });

  it("keeps the token it has when the authorization server can't be asked for another now", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.token = () => oauthError("server_error", 503);
    asked = [];

    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(tokenRequests()).toHaveLength(1);
    expect(asked.filter(({ url }) => url === TRACKER).every(({ authorization }) => authorization === "Bearer access-1")).toBe(true);
    expect((await appOf(await show(administrator, app.id))).signIn?.ended).toBe(false);
  });

  it("asks an app as it's signed in to by then, when an administrator signs in again while Ember gets the last sign-in's next token", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    // The administrator is at the authorization server, and comes back just as Ember asks it for the last sign-in's next token,
    // which it refuses: it has given the next sign-in's tokens since.
    const back = comeBack(await sentTo(await beginAgain(administrator, app.id)));
    vi.spyOn(console, "error").mockImplementation(() => {});
    let again: App | undefined;
    auth.token = async ({ grant_type: grant }) => {
      if (grant !== "refresh_token" || again) return null;
      auth.expiresIn = 3600;
      again = await signedInBy(await finish(administrator, back), 200);
      return null;
    };
    asked = [];

    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(tokenRequests().map(({ grant_type: grant }) => grant)).toEqual(["refresh_token", "authorization_code"]);
    // The refusal ends nothing, as the sign-in it was for is no longer the app's: the server is asked with the next one's token.
    const tools = asked.filter(({ url, json }) => url === TRACKER && json?.method === "tools/list");
    expect(tools.map(({ authorization }) => authorization)).toEqual([`Bearer ${auth.access}`, `Bearer ${auth.access}`]);
    expect((await appOf(await show(administrator, app.id))).signIn).toEqual({ ...again!.signIn, ended: false });
    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(tokenRequests()).toHaveLength(2);
  });

  it("doesn't keep what a server answered one account, once an administrator has signed in to it again as it answered", async () => {
    const administrator = await setUp();
    const app = await signIn(administrator);
    // The read that's under way was answered with one tool, and the sign-in made meanwhile reads two.
    auth.listing = async () => {
      auth.tools = [SEARCH_ISSUES, CLOSE_ISSUE];
      await signInAgain(administrator, app.id);
    };

    expect(await refusalOf(await readAgain(administrator, app.id), 409)).toEqual({ error: APP_CHANGED });
    expect((await appOf(await show(administrator, app.id))).tools.map(({ name }) => name)).toEqual(["search_issues", "close_issue"]);
  });

  it("doesn't send a call of a tool that's taken from its agent, or whose app is removed, while Ember gets the sign-in's next token", async () => {
    const administrator = await setUp();
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    await pick(administrator, true);
    const { name, fingerprint } = (await offered(administrator))[0]!.tools[0]!;
    const tool = { appId: app.id, name, fingerprint };
    const called = () => workspaceStub().appToolCall(ASSISTANT_ID, tool, false);
    expect(await called()).toMatchObject({ url: TRACKER, key: { token: "access-2", signedIn: true }, signedIn: true });

    auth.token = async () => (await pick(administrator, false), null);
    expect(await called()).toBeNull();
    auth.token = () => null;
    await pick(administrator, true);
    expect(await called()).toMatchObject({ key: { token: "access-4" } });

    // Its removal waits for the token Ember is getting, to have its service take that back too.
    const [uncalled, removing] = await removedWhileAsking(administrator, app.id, called);
    expect(uncalled).toBeNull();
    expect(await removed(removing)).toEqual({ revoked: false });
  });

  it("keeps a signed-in app's address, and takes no token for it, as its sign-in is to the server there", async () => {
    const administrator = await setUp();
    const app = await signIn(administrator);
    asked = [];

    expect(await refusalOf(await change(administrator, app.id, { url: "https://mcp.elsewhere.example/mcp" }))).toEqual({ error: APP_SIGNED_IN, field: "url" });
    expect(await refusalOf(await change(administrator, app.id, { token: "a-token-in-its-place" }))).toEqual({ error: APP_SIGNED_IN, field: "token" });
    expect(await refusalOf(await change(administrator, app.id, { token: "" }))).toEqual({ error: APP_SIGNED_IN, field: "token" });
    expect(asked).toEqual([]);
    expect(await appOf(await change(administrator, app.id, { name: "Issues", url: TRACKER }))).toMatchObject({ name: "Issues", url: TRACKER, signIn: { ended: false } });
  });

  it("offers a sign-in for an app whose server takes its token no longer, which signing in then takes the place of", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.access = "a-token-the-server-takes";
    const connected = await connect(administrator, { ...TRACKER_APP, token: "a-token-the-server-takes" });
    expect(connected.status, await connected.clone().text()).toBe(201);
    const { app } = (await connected.json()) as AppAnswer;
    expect(app).toMatchObject({ hasToken: true, signIn: null });

    auth.access = null;
    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: "mcp.tracker.example didn't take that token.", signIn: true });
    expect(await refusalOf(await change(administrator, app.id, { token: "another-token" }))).toEqual({ error: "mcp.tracker.example didn't take that token.", field: "token", signIn: true });

    const signedIn = await signInAgain(administrator, app.id);
    expect(signedIn).toMatchObject({ id: app.id, hasToken: false, signIn: { by: administrator.user, ended: false, clientId: null } });
    expect(await workspaceSql("SELECT token FROM apps")).toEqual([{ token: null }]);
    expect((await readAgain(administrator, app.id)).status).toBe(200);
  });

  it("forgets a sign-in under way to an app that's removed", async () => {
    const administrator = await setUp();
    const app = await signIn(administrator);
    const back = comeBack(await sentTo(await beginAgain(administrator, app.id)));

    expect((await disconnect(administrator, app.id)).status).toBe(200);
    expect(await workspaceSql("SELECT count(*) AS n FROM app_sign_ins")).toEqual([{ n: 0 }]);
    expect(await refusalOf(await finish(administrator, back))).toEqual({ error: APP_SIGN_IN_ENDED });
  });

  it("signs in as the client an administrator gives, where the service doesn't let Ember register itself, and keeps it for signing in again", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.registers = false;
    auth.client = { id: "ember-oauth-app", secret: "s3cret-of-the-client" };
    auth.expiresIn = 30;
    const proven = `Basic ${btoa("ember-oauth-app:s3cret-of-the-client")}`;
    const provenAt = () => asked.filter(({ url }) => url === `${AUTH}/token`).map(({ authorization, form }) => [form!.grant_type, authorization]);

    expect(await refusalOf(await begin(administrator))).toEqual(UNREGISTERED);
    expect(await refusalOf(await begin(administrator, { ...TRACKER_APP, clientSecret: "s3cret-of-the-client" }))).toEqual({ error: "A client secret goes with a client ID", field: "clientId" });
    expect(await refusalOf(await begin(administrator, { ...TRACKER_APP, clientId: "ember\noauth" }))).toMatchObject({ field: "clientId" });

    // The browser goes there as that client, which nothing is asked to register, and the code it comes back with is exchanged with the secret.
    asked = [];
    const authorizationUrl = await sentTo(await begin(administrator, { ...TRACKER_APP, clientId: " ember-oauth-app ", clientSecret: "s3cret-of-the-client" }));
    expect(authorizationUrl.searchParams.get("client_id")).toBe("ember-oauth-app");
    expect(asked.some(({ url }) => url === `${AUTH}/register`)).toBe(false);
    const app = await signedInBy(await finish(administrator, comeBack(authorizationUrl)));
    expect(app.signIn).toMatchObject({ ended: false, clientId: "ember-oauth-app" });
    expect(provenAt()).toEqual([["authorization_code", proven]]);
    // The client's ID is kept to show, and its secret sealed, beside the sign-in.
    const [kept] = (await workspaceSql("SELECT sign_in, sign_in_client_id, sign_in_client FROM apps")) as [{ sign_in: string; sign_in_client_id: string; sign_in_client: string }];
    expect(kept.sign_in_client_id).toBe("ember-oauth-app");
    expect(JSON.stringify(kept)).not.toContain("s3cret");

    // Another token is asked for as that client too.
    asked = [];
    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(provenAt()).toEqual([["refresh_token", proven]]);

    // Once the sign-in has ended, signing in again asks for neither again.
    auth.token = ({ grant_type: grant }) => (grant === "refresh_token" ? oauthError("invalid_grant") : null);
    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: signInEnded("Tracker") });
    expect((await appOf(await show(administrator, app.id))).signIn).toMatchObject({ ended: true, clientId: "ember-oauth-app" });
    asked = [];
    const again = await sentTo(await beginAgain(administrator, app.id));
    expect(again.searchParams.get("client_id")).toBe("ember-oauth-app");
    expect((await signedInBy(await finish(administrator, comeBack(again)), 200)).signIn).toMatchObject({ ended: false, clientId: "ember-oauth-app" });
    expect(provenAt()).toEqual([["authorization_code", proven]]);
    // Nor does the app's page, which sends the client ID as it shows it, with no secret.
    asked = [];
    const untouched = await sentTo(await beginAgain(administrator, app.id, { clientId: "ember-oauth-app" }));
    await signedInBy(await finish(administrator, comeBack(untouched)), 200);
    expect(provenAt()).toEqual([["authorization_code", proven]]);

    // Another client ID goes without the last one's secret, which the service refuses here, leaving the app signed in as it was.
    asked = [];
    const other = await sentTo(await beginAgain(administrator, app.id, { clientId: "another-app" }));
    expect(other.searchParams.get("client_id")).toBe("another-app");
    expect(await refusalOf(await finish(administrator, comeBack(other)))).toEqual({
      error: "mcp.tracker.example didn't take the client ID or secret Ember signed in with. Check both, and start the sign-in again.",
    });
    expect(JSON.stringify(asked)).not.toContain("s3cret");
    expect((await appOf(await show(administrator, app.id))).signIn).toMatchObject({ ended: false, clientId: "ember-oauth-app" });

    // With none, Ember has the service come to know it by itself, where it can, and keeps no client.
    expect(await refusalOf(await beginAgain(administrator, app.id, { clientId: "" }))).toEqual(UNREGISTERED);
    auth.registers = true;
    auth.client = null;
    const itself = await sentTo(await beginAgain(administrator, app.id, { clientId: "" }));
    expect(itself.searchParams.get("client_id")).toBe("ember-at-tracker");
    expect((await signedInBy(await finish(administrator, comeBack(itself)), 200)).signIn).toMatchObject({ clientId: null });
    expect(await workspaceSql("SELECT sign_in_client_id, sign_in_client FROM apps")).toEqual([{ sign_in_client_id: null, sign_in_client: null }]);
  });

  it("says why when a server's sign-in is one Ember can't use, and keeps nothing", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const elsewhere = { error: "mcp.tracker.example sends its sign-in somewhere Ember doesn't ask: an address that isn't public, or isn't https.", field: "url" };

    // An authorization server on a private network, or one that signs people in over plain http.
    auth.resource = (resource) => ({ ...resource, authorization_servers: ["https://auth.internal.example"] });
    expect(await refusalOf(await begin(administrator))).toEqual(elsewhere);
    expect(asked.some(({ url }) => url.startsWith("https://auth.internal.example"))).toBe(false);
    auth.resource = (resource) => resource;
    auth.metadata = (metadata) => ({ ...metadata, authorization_endpoint: "http://auth.tracker.example/authorize" });
    expect(await refusalOf(await begin(administrator))).toEqual(elsewhere);
    // One that would send the administrator's browser to a private network, which Ember looks up as it does what it asks itself.
    auth.metadata = (metadata) => ({ ...metadata, authorization_endpoint: "https://auth.internal.example/authorize" });
    expect(await refusalOf(await begin(administrator))).toEqual(elsewhere);
    expect(asked.some(({ url }) => url.startsWith("https://auth.internal.example"))).toBe(false);

    // One that says it's another service's, or is for another server.
    auth.metadata = (metadata) => ({ ...metadata, issuer: "https://auth.elsewhere.example" });
    expect(await refusalOf(await begin(administrator))).toEqual({ error: "The sign-in mcp.tracker.example names says it's another service's, so Ember won't use it.", field: "url" });
    auth.metadata = (metadata) => metadata;
    auth.resource = (resource) => ({ ...resource, resource: "https://mcp.elsewhere.example/mcp" });
    expect(await refusalOf(await begin(administrator))).toEqual({ error: "The sign-in mcp.tracker.example describes is for another address than its own, so Ember won't use it.", field: "url" });
    auth.resource = (resource) => resource;

    // One that neither reads Ember's document nor registers it, and a server that describes none.
    auth.registers = false;
    expect(await refusalOf(await begin(administrator))).toEqual(UNREGISTERED);
    auth.resource = () => null;
    auth.metadata = () => null;
    expect(await refusalOf(await begin(administrator))).toEqual({ error: "mcp.tracker.example doesn't say how to sign in to it. Give a token for it, if it has one.", field: "token" });

    expect(await workspaceSql("SELECT count(*) AS n FROM app_sign_ins")).toEqual([{ n: 0 }]);
  });
});

describe("An app whose server asks for more than Ember's sign-in to it allows", () => {
  const MORE = "mcp.tracker.example took Ember's sign-in, but says it doesn't allow this. Sign in to it again to allow it.";
  const listed = async (administrator: Session) => ((await (await api("/api/account/apps", { headers: as(administrator) })).json()) as Apps).apps;

  it("keeps what a call was refused for want of, tells the model who can allow it, and asks for it with what the sign-in had when an administrator signs in again", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await signIn(administrator);
    const tool = await pickedTool(administrator, app);
    expect(await tool.run({})).toBe("Done.");
    expect(app.signIn).toMatchObject({ wantsScope: null });
    expect(await listed(administrator)).toMatchObject([{ wantsAccess: false }]);

    // The server refuses the call, which then hasn't run, and names what would allow it.
    auth.needs = { method: "tools/call", scope: "issues:write" };
    await expect(tool.run({})).rejects.toThrow(`Not run: ${wantsMoreAccess("Tracker")}`);
    expect(await appOf(await show(administrator, app.id))).toMatchObject({ signIn: { ended: false, wantsScope: "issues:write" } });
    expect(await listed(administrator)).toMatchObject([{ wantsAccess: true, signInEnded: false }]);

    // Asked for again, it's kept once, and something else it asks for is kept beside it.
    await expect(tool.run({})).rejects.toThrow(wantsMoreAccess("Tracker"));
    auth.needs = { method: "tools/call", scope: "projects:read issues:write" };
    await expect(tool.run({})).rejects.toThrow(wantsMoreAccess("Tracker"));
    expect(await workspaceSql("SELECT scope_wanted FROM apps")).toEqual([{ scope_wanted: "issues:write projects:read" }]);

    // Signing in again asks for what the sign-in had and for what was asked since, and nothing is wanted once it's made.
    const authorizationUrl = await sentTo(await beginAgain(administrator, app.id));
    expect(authorizationUrl.searchParams.get("scope")).toBe("issues issues:write projects:read");
    const again = await signedInBy(await finish(administrator, comeBack(authorizationUrl)), 200);
    expect(again.signIn).toMatchObject({ ended: false, wantsScope: null });
    expect(await workspaceSql("SELECT scope_wanted FROM apps")).toEqual([{ scope_wanted: null }]);
    expect(await listed(administrator)).toMatchObject([{ wantsAccess: false }]);
    expect(await tool.run({})).toBe("Done.");
  });

  it("takes an authorization server that doesn't say what its tokens allow to have given what was asked for, which the next sign-in asks for again", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.saysScope = false;
    const app = await signIn(administrator);
    const tool = await pickedTool(administrator, app);
    auth.needs = { method: "tools/call", scope: "issues:write" };
    await expect(tool.run({})).rejects.toThrow(wantsMoreAccess("Tracker"));
    const authorizationUrl = await sentTo(await beginAgain(administrator, app.id));
    expect(authorizationUrl.searchParams.get("scope")).toBe("issues issues:write");
    await signedInBy(await finish(administrator, comeBack(authorizationUrl)), 200);
    expect(await tool.run({})).toBe("Done.");

    // What that sign-in was given isn't forgotten when the server asks for something else.
    auth.needs = { method: "tools/call", scope: "projects:read" };
    await expect(tool.run({})).rejects.toThrow(wantsMoreAccess("Tracker"));
    expect((await sentTo(await beginAgain(administrator, app.id))).searchParams.get("scope")).toBe("issues issues:write projects:read");
  });

  it("keeps each of the scopes two calls are refused for want of at once", async () => {
    const administrator = await setUp();
    const app = await signIn(administrator);
    await pick(administrator, true);
    const { name, fingerprint } = (await offered(administrator))[0]!.tools[0]!;
    const askedAt = (await workspaceStub().appToolCall(ASSISTANT_ID, { appId: app.id, name, fingerprint }, false))!;

    await Promise.all(["issues:write", "projects:read", "labels:write"].map((scope) => workspaceStub().keepAppScopeWanted(app.id, scope, askedAt)));
    expect(await workspaceSql("SELECT scope_wanted FROM apps")).toEqual([{ scope_wanted: "issues:write projects:read labels:write" }]);
  });

  it("tells the room that a call it was shown, made without asking first, wasn't made for want of access", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await signIn(administrator);
    const { name, fingerprint } = (await offered(administrator))[0]!.tools[0]!;
    const always = { tools: [{ appId: app.id, name, fingerprint, alwaysAllowed: true }] };
    expect((await api(`/api/account/agents/${ASSISTANT_ID}/tools`, { method: "PUT", headers: as(administrator), body: JSON.stringify(always) })).status).toBe(200);
    const told: Unmade[] = [];
    const shown = async () => ({ unmade: async (why: Unmade) => void told.push(why) });
    const tool = appTool(env as unknown as Env, ASSISTANT_ID, { appId: app.id, appName: app.name, name, fingerprint, as: name }, NOWHERE, { shown });

    expect(await tool.run({})).toBe("Done.");
    auth.needs = { method: "tools/call", scope: "issues:write" };
    await expect(tool.run({})).rejects.toThrow(`Not run: ${wantsMoreAccess("Tracker")}`);
    expect(told).toEqual(["refused"]);
    expect(unmadeFor("Ember", "Tracker", "refused")).toBe(`Not run: ${wantsMoreAccess("Tracker")}`);
  });

  it("keeps what reading its tools again was refused for want of, which says to sign in again", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await signIn(administrator);
    auth.needs = { method: "tools/list", scope: "tools:read" };

    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: MORE });
    expect(await appOf(await show(administrator, app.id))).toMatchObject({ signIn: { wantsScope: "tools:read" } });
    const authorizationUrl = await sentTo(await beginAgain(administrator, app.id));
    expect(authorizationUrl.searchParams.get("scope")).toBe("issues tools:read");
    expect(await signedInBy(await finish(administrator, comeBack(authorizationUrl)), 200)).toMatchObject({ signIn: { wantsScope: null } });
    expect((await readAgain(administrator, app.id)).status).toBe(200);
  });

  it("asks for what was asked since once the sign-in has ended too, with what the server asks of a sign-in", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    const tool = await pickedTool(administrator, app);
    auth.needs = { method: "tools/call", scope: "issues:write" };
    await expect(tool.run({})).rejects.toThrow(wantsMoreAccess("Tracker"));

    auth.token = ({ grant_type: grant }) => (grant === "refresh_token" ? oauthError("invalid_grant") : null);
    await expect(tool.run({})).rejects.toThrow(`Not run: ${signInEnded("Tracker")}`);
    expect(await appOf(await show(administrator, app.id))).toMatchObject({ signIn: { ended: true, wantsScope: "issues:write" } });
    expect((await sentTo(await beginAgain(administrator, app.id))).searchParams.get("scope")).toBe("issues issues:write");
  });

  it("keeps nothing a server asks for that's no scope, or once the app is signed in to again, and a token's refusal offers no sign-in again", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await signIn(administrator);
    const tool = await pickedTool(administrator, app);

    // What isn't a scope is asked of nobody, and the model is told what the server said.
    auth.needs = { method: "tools/call", scope: "issues\\write" };
    await expect(tool.run({})).rejects.toThrow("Not run: mcp.tracker.example took Ember's sign-in, but says it doesn't allow this.");
    expect(await workspaceSql("SELECT scope_wanted FROM apps")).toEqual([{ scope_wanted: null }]);

    // What a server asked of a sign-in that an administrator has made again since isn't that one's to ask for.
    const before = (await workspaceStub().appToolCall(ASSISTANT_ID, { appId: app.id, name: "search_issues", fingerprint: (await offered(administrator))[0]!.tools[0]!.fingerprint }, false))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await signInAgain(administrator, app.id);
    await workspaceStub().keepAppScopeWanted(app.id, "issues:write", before);
    expect(await workspaceSql("SELECT scope_wanted FROM apps")).toEqual([{ scope_wanted: null }]);
    await workspaceStub().keepAppScopeWanted(app.id, "x".repeat(1001), (await workspaceStub().appToolCall(ASSISTANT_ID, { appId: app.id, name: "search_issues", fingerprint: (await offered(administrator))[0]!.tools[0]!.fingerprint }, false))!);
    expect(await workspaceSql("SELECT scope_wanted FROM apps")).toEqual([{ scope_wanted: null }]);
  });

  it("reads scopes as OAuth has them, each once", () => {
    expect(scopesOf("issues  issues:write issues")).toBe("issues issues:write");
    expect(scopesOf("https://tracker.example/auth/issues.read openid")).toBe("https://tracker.example/auth/issues.read openid");
    for (const none of [undefined, null, "", "  ", 'issues"write', "issues\\write", "issues\twrite", "ißues", "x".repeat(1001)]) expect(scopesOf(none)).toBeNull();
    expect(scopesWith("issues", "issues:write issues")).toBe("issues issues:write");
    expect(scopesWith(null, "issues")).toBe("issues");
    expect(scopesWith(null, null)).toBeNull();
  });
});

describe("Removing an app Ember is signed in to", () => {
  it("takes back what the sign-in gave, at the service, as the client it signed in as, once the app is gone", async () => {
    const administrator = await setUp();
    auth.revokes = true;
    const app = await signIn(administrator);
    asked = [];

    expect(await removed(await disconnect(administrator, app.id))).toEqual({ revoked: true });
    expect(revocations()).toEqual([
      { form: { token: "refresh-1", token_type_hint: "refresh_token", client_id: "ember-at-tracker" }, authorization: null, redirect: "manual", timed: true },
      { form: { token: "access-1", token_type_hint: "access_token", client_id: "ember-at-tracker" }, authorization: null, redirect: "manual", timed: true },
    ]);
    expect([auth.access, auth.refresh]).toEqual([null, null]);
    expect(await workspaceSql("SELECT count(*) AS n FROM apps")).toEqual([{ n: 0 }]);
  });

  it("proves itself with the secret of the client an administrator gave, and takes back a sign-in that has no token to get another with", async () => {
    const administrator = await setUp();
    Object.assign(auth, { revokes: true, registers: false, refreshes: false, client: { id: "ember-registered", secret: "s3cret" } });
    const app = await signedInBy(await finish(administrator, comeBack(await sentTo(await begin(administrator, { ...TRACKER_APP, clientId: "ember-registered", clientSecret: "s3cret" })))));
    asked = [];

    expect(await removed(await disconnect(administrator, app.id))).toEqual({ revoked: true });
    expect(revocations()).toEqual([{ form: { token: "access-1", token_type_hint: "access_token" }, authorization: `Basic ${btoa("ember-registered:s3cret")}`, redirect: "manual", timed: true }]);
  });

  it("proves itself with a client ID and secret a header has to encode, each encoded as OAuth has it, the same at every request, so the service reads them as they are", async () => {
    const administrator = await setUp();
    const client = { id: "urn:ember:tracker", secret: "s3cret+of/the%client=" };
    Object.assign(auth, { revokes: true, registers: false, expiresIn: 30, client });
    const app = await signedInBy(await finish(administrator, comeBack(await sentTo(await begin(administrator, { ...TRACKER_APP, clientId: client.id, clientSecret: client.secret })))));
    expect((await readAgain(administrator, app.id)).status).toBe(200);
    expect(await removed(await disconnect(administrator, app.id))).toEqual({ revoked: true });

    const proven = `Basic ${btoa("urn%3Aember%3Atracker:s3cret%2Bof%2Fthe%25client%3D")}`;
    const toService = asked.filter(({ url }) => url === `${AUTH}/token` || url === `${AUTH}/revoke`);
    expect(toService.map(({ url, form, authorization }) => [url.slice(AUTH.length), form!.grant_type ?? form!.token_type_hint, authorization])).toEqual([
      ["/token", "authorization_code", proven],
      ["/token", "refresh_token", proven],
      ["/revoke", "refresh_token", proven],
      ["/revoke", "access_token", proven],
    ]);
    expect([auth.access, auth.refresh]).toEqual([null, null]);
  });

  it("removes the app all the same where the service doesn't take the sign-in back, or doesn't say how, which it answers", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});

    // A service that says nothing of taking tokens back is asked nothing.
    const unsaid = await signIn(administrator);
    asked = [];
    expect(await removed(await disconnect(administrator, unsaid.id))).toEqual({ revoked: false });
    expect(asked).toEqual([]);

    // One that fails, and one that names somewhere Ember doesn't ask.
    auth.revokes = true;
    auth.revoked = () => new Response(null, { status: 503 });
    const failing = await signIn(administrator);
    expect(await removed(await disconnect(administrator, failing.id))).toEqual({ revoked: false });
    auth.metadata = (metadata) => ({ ...metadata, revocation_endpoint: "https://auth.internal.example/revoke" });
    const inside = await signIn(administrator);
    asked = [];
    expect(await removed(await disconnect(administrator, inside.id))).toEqual({ revoked: false });
    expect(asked.some(({ url }) => url.startsWith("https://auth.internal.example"))).toBe(false);
    expect(await workspaceSql("SELECT count(*) AS n FROM apps")).toEqual([{ n: 0 }]);
  });

  it("takes back the tokens Ember was getting as the app went, too, which ended the ones it kept", async () => {
    const administrator = await setUp();
    Object.assign(auth, { revokes: true, expiresIn: 30 });
    const app = await signIn(administrator);
    await pick(administrator, true);
    const { name, fingerprint } = (await offered(administrator))[0]!.tools[0]!;
    const called = (id: string) => () => workspaceStub().appToolCall(ASSISTANT_ID, { appId: id, name, fingerprint }, false);
    asked = [];

    // The service gives the sign-in's next tokens, and the app is removed before Ember has them.
    const [uncalled, removing] = await removedWhileAsking(administrator, app.id, called(app.id), () => nextTokens(undefined));
    expect(uncalled).toBeNull();
    expect(await removed(removing)).toEqual({ revoked: true });
    expect(
      revocations()
        .map(({ form }) => form?.token)
        .sort(),
    ).toEqual(["access-1", "access-2", "refresh-1", "refresh-2"]);
    expect([auth.access, auth.refresh]).toEqual([null, null]);

    // A service that doesn't take those back hasn't taken the sign-in back.
    const again = await signIn(administrator);
    await pick(administrator, true);
    auth.revoked = () => (asked.some(({ form }) => form?.token === auth.refresh) ? new Response(null, { status: 503 }) : null);
    const [, unrevoked] = await removedWhileAsking(administrator, again.id, called(again.id), () => nextTokens(undefined));
    expect(await removed(unrevoked)).toEqual({ revoked: false });
  });

  it("asks nothing of the service of an app whose sign-in has ended, or that has a token", async () => {
    const administrator = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.revokes = true;
    auth.expiresIn = 30;
    const app = await signIn(administrator);
    auth.token = ({ grant_type: grant }) => (grant === "refresh_token" ? oauthError("invalid_grant") : null);
    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: signInEnded("Tracker") });
    asked = [];

    expect((await disconnect(administrator, app.id)).status).toBe(204);
    expect(asked).toEqual([]);
  });
});

const beginOwn = (session: Session | null, id: string) => api(`/api/users/me/apps/${id}/sign-in`, { method: "POST", headers: as(session) });
const signOut = (session: Session | null, id: string) => api(`/api/users/me/apps/${id}/sign-in`, { method: "DELETE", headers: as(session) });

/** The connected apps `session`'s profile lists, each with the sign-in they've made to it themselves, if they have. */
const yourApps = async (session: Session) => ((await (await api("/api/users/me/profile", { headers: as(session) })).json()) as ProfileAnswer).profile.apps;

/** Signs `person` in to the connected app `id` themselves, at the fake service, which leaves the sign-ins it gave before good: the app as their profile then lists it. */
async function signInAsSelf(person: Session, id: string): Promise<YourApp> {
  auth.keepsOthers = true;
  const response = await finish(person, comeBack(await sentTo(await beginOwn(person, id))));
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as YourAppSignedIn).yours;
}

/** The room of `person`'s direct conversation with @ember. */
async function directWithEmber(person: Session): Promise<RoomId> {
  const response = await startDirect(person, [ASSISTANT_ID]);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { room: { id: RoomId } }).room.id;
}

/** The tokens the fake server's tool was called with. */
const callTokens = () => asked.filter(({ url, json }) => url === TRACKER && json?.method === "tools/call").map(({ authorization }) => authorization);

describe("A sign-in someone makes to an app themselves", () => {
  /** Ember signed in to Tracker, its tool picked for @ember, and Grace, a member, in her direct conversation with @ember: the tool as a model is given it, hers there once she has signed in herself. */
  async function withGrace(): Promise<{ administrator: Session; member: Session; app: App; tool: GivenTool; own: GivenTool; dm: RoomId; asGrace: { roomId: RoomId; askerId: string } }> {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const app = await signIn(administrator);
    await pick(administrator, true);
    const { name, fingerprint } = (await offered(administrator))[0]!.tools[0]!;
    const tool: GivenTool = { appId: app.id, appName: app.name, name, fingerprint, as: name };
    const dm = await directWithEmber(member);
    return { administrator, member, app, tool, own: { ...tool, own: true }, dm, asGrace: { roomId: dm, askerId: member.user.id } };
  }

  const called = (tool: GivenTool, asked: { roomId: RoomId; askerId: string }) => appTool(env as unknown as Env, ASSISTANT_ID, tool, asked).run({});

  it("is offered on their profile for each app Ember signs in to, and is kept as theirs, beside Ember's", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    expect(await yourApps(member)).toEqual([]);
    const app = await signIn(administrator);
    const unsigned: YourApp = { id: app.id, name: "Tracker", signedInAt: null, ended: false, wantsMore: false };
    expect(await yourApps(member)).toEqual([unsigned]);

    const to = await sentTo(await beginOwn(member, app.id));
    expect(to.origin + to.pathname).toBe(`${AUTH}/authorize`);
    expect(to.searchParams.get("redirect_uri")).toBe(BACK);
    expect(to.searchParams.get("scope")).toBe("issues");
    auth.keepsOthers = true;
    const finished = await finish(member, comeBack(to));
    expect(finished.status, await finished.clone().text()).toBe(200);
    expect(finished.headers.get("Cache-Control")).toBe("no-store");
    const { yours } = (await finished.json()) as YourAppSignedIn;
    expect(yours).toEqual({ ...unsigned, signedInAt: expect.any(String) });
    expect(await yourApps(member)).toEqual([yours]);

    // It's hers alone, sealed, and Ember's sign-in is as it was.
    expect(await yourApps(administrator)).toEqual([unsigned]);
    expect((await appOf(await show(administrator, app.id))).signIn).toEqual(app.signIn);
    const [kept] = (await workspaceSql("SELECT user_id, sign_in FROM own_app_sign_ins")) as [{ user_id: string; sign_in: string }];
    expect(kept.user_id).toBe(member.user.id);
    expect(kept.sign_in).not.toContain("access-2");
    expect(await workspaceSql("SELECT count(*) AS n FROM app_sign_ins")).toEqual([{ n: 0 }]);
  });

  it("has what an agent does with the app in their direct conversation with it go as them, and nowhere else", async () => {
    const { administrator, member, app, tool, own, dm, asGrace } = await withGrace();
    const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE kind <> 'direct' ORDER BY created_at LIMIT 1")) as [{ id: RoomId }];
    const toolsIn = async (room: RoomId, asker: Session) => (await workspaceStub().answererIn(room, ASSISTANT_ID, asker.user.id))!.appTools.map(({ name, own, alwaysAllowed }) => ({ name, own, alwaysAllowed }));
    expect(await toolsIn(dm, member)).toEqual([{ name: tool.name, own: undefined, alwaysAllowed: false }]);

    await signInAsSelf(member, app.id);
    expect(await toolsIn(dm, member)).toEqual([{ name: tool.name, own: true, alwaysAllowed: false }]);
    expect(await toolsIn(general, member)).toEqual([{ name: tool.name, own: undefined, alwaysAllowed: false }]);
    expect(await toolsIn(await directWithEmber(administrator), administrator)).toEqual([{ name: tool.name, own: undefined, alwaysAllowed: false }]);
    asked = [];

    expect(await called(own, asGrace)).toBe("Done.");
    expect(callTokens()).toEqual(["Bearer access-2"]);
    // A call that wasn't to go as her goes with Ember's sign-in, as its card said.
    expect(await called(tool, asGrace)).toBe("Done.");
    expect(callTokens()).toEqual(["Bearer access-2", "Bearer access-1"]);
    // One that was goes nowhere outside that conversation, or for someone who isn't in it.
    await expect(called(own, { roomId: general, askerId: member.user.id })).rejects.toThrow("isn't one of your tools any more");
    await expect(called(own, { roomId: dm, askerId: administrator.user.id })).rejects.toThrow("isn't one of your tools any more");
    expect(callTokens()).toHaveLength(2);

    // What an administrator always allows was said of Ember's sign-in: as her, every call asks first.
    const always = { tools: [{ appId: app.id, name: tool.name, fingerprint: tool.fingerprint, alwaysAllowed: true }] };
    expect((await api(`/api/account/agents/${ASSISTANT_ID}/tools`, { method: "PUT", headers: as(administrator), body: JSON.stringify(always) })).status).toBe(200);
    expect(await toolsIn(general, member)).toEqual([{ name: tool.name, own: undefined, alwaysAllowed: true }]);
    expect(await toolsIn(dm, member)).toEqual([{ name: tool.name, own: true, alwaysAllowed: false }]);
    const shown = async () => ({ unmade: async () => {} });
    await expect(appTool(env as unknown as Env, ASSISTANT_ID, own, asGrace, { shown }).run({})).rejects.toThrow("each call of it has to be allowed now");
    expect(callTokens()).toHaveLength(2);
  });

  it("gets its next tokens apart from Ember's, and isn't made up for with Ember's once it has ended", async () => {
    auth.expiresIn = 30;
    const { administrator, member, app, tool, own, asGrace } = await withGrace();
    await signInAsSelf(member, app.id);
    asked = [];

    expect(await called(own, asGrace)).toBe("Done.");
    expect(tokenRequests()).toMatchObject([{ grant_type: "refresh_token", refresh_token: "refresh-2" }]);
    expect(callTokens()).toEqual(["Bearer access-3"]);
    expect(await called(tool, asGrace)).toBe("Done.");
    expect(tokenRequests().at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    expect(callTokens()).toEqual(["Bearer access-3", "Bearer access-4"]);

    // Her sign-in ends: the call isn't made, with hers or with Ember's, and her profile says so.
    auth.token = ({ refresh_token: refresh }) => (refresh === "refresh-3" ? oauthError("invalid_grant") : null);
    await expect(called(own, asGrace)).rejects.toThrow(`Not run: ${ownSignInEnded("Tracker")}`);
    expect(callTokens()).toHaveLength(2);
    expect(await yourApps(member)).toMatchObject([{ signedInAt: expect.any(String), ended: true }]);
    expect((await appOf(await show(administrator, app.id))).signIn?.ended).toBe(false);
    expect((await workspaceStub().answererIn(asGrace.roomId, ASSISTANT_ID, member.user.id))!.appTools[0]!.own).toBe(true);

    // Signing in again makes it hers to use again.
    auth.token = () => null;
    expect(await signInAsSelf(member, app.id)).toMatchObject({ ended: false });
    expect(await called(own, asGrace)).toBe("Done.");
  });

  it("is asked for more by the app's server for them alone, which their signing in again asks for", async () => {
    const { administrator, member, app, own, asGrace } = await withGrace();
    await signInAsSelf(member, app.id);
    auth.needs = { method: "tools/call", scope: "issues:write" };

    await expect(called(own, asGrace)).rejects.toThrow(`Not run: ${ownWantsMoreAccess("Tracker")}`);
    expect(await yourApps(member)).toMatchObject([{ wantsMore: true, ended: false }]);
    expect((await appOf(await show(administrator, app.id))).signIn?.wantsScope).toBeNull();

    const to = await sentTo(await beginOwn(member, app.id));
    expect(to.searchParams.get("scope")).toBe("issues issues:write");
    const finished = await finish(member, comeBack(to));
    expect(((await finished.json()) as YourAppSignedIn).yours).toMatchObject({ wantsMore: false });
    expect(await called(own, asGrace)).toBe("Done.");
  });

  it("is forgotten when they sign out, which has its service take it back, and leaves Ember's", async () => {
    auth.revokes = true;
    const { member, app, tool, own, asGrace } = await withGrace();
    const unsigned: YourApp = { id: app.id, name: "Tracker", signedInAt: null, ended: false, wantsMore: false };
    expect(await refusalOf(await signOut(member, app.id), 404)).toEqual({ error: YOUR_APP_GONE });
    await signInAsSelf(member, app.id);
    asked = [];

    expect(await refusalOf(await signOut(null, app.id), 401)).toEqual({ error: "Not signed in" });
    const signedOut = await signOut(member, app.id);
    expect(signedOut.status, await signedOut.clone().text()).toBe(200);
    expect((await signedOut.json()) as YourAppSignedOut).toEqual({ apps: [unsigned], revoked: true });
    expect(revocations().map(({ form }) => form?.token)).toEqual(["refresh-2", "access-2"]);
    expect(await workspaceSql("SELECT count(*) AS n FROM own_app_sign_ins")).toEqual([{ n: 0 }]);

    // What was to go as her isn't made with Ember's, and what she asks next goes with Ember's.
    await expect(called(own, asGrace)).rejects.toThrow(`Not run: ${ownSignInEnded("Tracker")}`);
    expect((await workspaceStub().answererIn(asGrace.roomId, ASSISTANT_ID, member.user.id))!.appTools[0]!.own).toBeUndefined();
    expect(await called(tool, asGrace)).toBe("Done.");
    expect(callTokens()).toEqual(["Bearer access-1"]);

    // A service that doesn't take it back is said not to have: the sign-in is forgotten all the same.
    await signInAsSelf(member, app.id);
    auth.revoked = () => new Response(null, { status: 503 });
    expect((await (await signOut(member, app.id)).json()) as YourAppSignedOut).toEqual({ apps: [unsigned], revoked: false });
  });

  it("goes with its app, whose removal has the service take it back too", async () => {
    auth.revokes = true;
    const { administrator, member, app } = await withGrace();
    await signInAsSelf(member, app.id);
    await beginOwn(administrator, app.id);
    asked = [];

    expect(await removed(await disconnect(administrator, app.id))).toEqual({ revoked: true });
    expect(
      revocations()
        .map(({ form }) => form?.token)
        .sort(),
    ).toEqual(["access-1", "access-2", "refresh-1", "refresh-2"]);
    expect(await workspaceSql("SELECT (SELECT count(*) FROM own_app_sign_ins) + (SELECT count(*) FROM app_sign_ins) AS n")).toEqual([{ n: 0 }]);
    expect(await yourApps(member)).toEqual([]);
  });

  it("is taken back when its app is removed after Ember's own sign-in has ended", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.revokes = true;
    auth.expiresIn = 30;
    const { administrator, member, app } = await withGrace();
    await signInAsSelf(member, app.id);
    auth.token = ({ refresh_token: refresh }) => (refresh === "refresh-1" ? oauthError("invalid_grant") : null);
    expect(await refusalOf(await readAgain(administrator, app.id))).toEqual({ error: signInEnded("Tracker") });
    asked = [];

    expect(await removed(await disconnect(administrator, app.id))).toEqual({ revoked: true });
    expect(
      revocations()
        .map(({ form }) => form?.token)
        .sort(),
    ).toEqual(["access-2", "refresh-2"]);
    expect(await workspaceSql("SELECT count(*) AS n FROM own_app_sign_ins")).toEqual([{ n: 0 }]);
  });

  it("goes with its person, when they're removed or banned", async () => {
    const { administrator, member, app } = await withGrace();
    const hal = await joinAs({ name: "Hal Abelson", emailAddress: "hal@example.com", password: "structure and interpretation" });
    await signInAsSelf(member, app.id);
    await signInAsSelf(hal, app.id);
    const whose = async () => ((await workspaceSql("SELECT user_id FROM own_app_sign_ins ORDER BY user_id")) as Array<{ user_id: string }>).map(({ user_id: id }) => id);
    expect(await whose()).toEqual([member.user.id, hal.user.id].sort());

    expect((await api(`/api/account/users/${member.user.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    expect(await whose()).toEqual([hal.user.id]);
    expect((await api(`/api/users/${hal.user.id}/ban`, { method: "POST", headers: as(administrator) })).status).toBe(200);
    expect(await whose()).toEqual([]);
  });

  it("is anyone's to begin, for an app Ember signs in to, while Ember AI is on, and only their own to finish", async () => {
    const { administrator, member, app } = await withGrace();
    expect(await refusalOf(await beginOwn(null, app.id), 401)).toEqual({ error: "Not signed in" });
    expect(await refusalOf(await beginOwn(member, "0mgk3x2a9b4c5e"), 404)).toEqual({ error: YOUR_APP_GONE });

    // Someone else's comes to nothing for whoever tries it, and is still its person's to finish.
    const adas = comeBack(await sentTo(await beginOwn(administrator, app.id)));
    expect(await refusalOf(await finish(member, adas))).toEqual({ error: APP_SIGN_IN_ENDED });
    // Each person has one under way: beginning another ends the last, and none of them crowds out Ember's.
    const embers = comeBack(await sentTo(await beginAgain(administrator, app.id)));
    const first = comeBack(await sentTo(await beginOwn(member, app.id)));
    const second = comeBack(await sentTo(await beginOwn(member, app.id)));
    expect(await workspaceSql("SELECT count(*) AS n FROM app_sign_ins WHERE own = 1")).toEqual([{ n: 2 }]);
    expect(await refusalOf(await finish(member, first))).toEqual({ error: APP_SIGN_IN_ENDED });
    auth.keepsOthers = true;
    expect((await finish(member, second)).status).toBe(200);
    expect((await finish(administrator, adas)).status).toBe(200);
    await signedInBy(await finish(administrator, embers), 200);
    expect((await yourApps(member))[0]!.signedInAt).not.toBeNull();

    // While Ember AI is off, nobody's profile lists an app, and none is signed in to.
    const pending = comeBack(await sentTo(await beginOwn(member, app.id)));
    expect((await api("/api/account/assistant", { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    expect(await yourApps(member)).toEqual([]);
    expect(await refusalOf(await beginOwn(member, app.id), 409)).toEqual({ error: ASSISTANT_OFF });
    expect(await refusalOf(await finish(member, pending), 409)).toEqual({ error: ASSISTANT_OFF });
    expect(await refusalOf(await signOut(member, app.id), 409)).toEqual({ error: ASSISTANT_OFF });
  });
});

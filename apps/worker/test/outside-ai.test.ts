import { HISTORY_PAGE_SIZE, MAX_MESSAGE_LENGTH, MAX_SEARCH_LENGTH, MESSAGE_TOO_LONG, type BotAnswer, type Me, type Message, type NewWorkspace, type ProfileAnswer, type RoomId, type WorkspaceSettings } from "@ember/protocol";
import {
  MAX_OUTSIDE_CONNECTIONS,
  OUTSIDE_ASK_REFUSED,
  OUTSIDE_CONNECTION_GONE,
  OUTSIDE_FORBIDDEN,
  OUTSIDE_FULL,
  OUTSIDE_GUEST,
  OUTSIDE_OFF,
  type OutsideAnswered,
  type OutsideAsk,
  type OutsideAsked,
  type YourOutsideAi,
} from "@ember/protocol/outside";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64url } from "../src/encoding";
import { MAX_SHOWN_LENGTH, MESSAGES_FOUND, SENDING_TOO_FAST } from "../src/outside/tools";
import { MAX_OUTSIDE_CLIENTS, OUTSIDE_SENDS_PER_MINUTE } from "../src/workspace";
import { api, connect, cookieOf, createRoom, direct, freshDeploy, origin, post, roomSql, settle, shown, signIn, upload, workspaceSql, type Session, type Socket } from "./support";

// Outside AI: an AI app connects to Ember over the Model Context Protocol, at `/mcp`, and signs in
// with OAuth, where Ember is the authorization server. The tests are the app: they find out how to sign
// in, register, are allowed by a person on Ember's page, exchange the code they're sent back with, and
// ask with the token that gives them.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "nanoseconds" };

/** Where the app has browsers sent back, and the address it connects to. */
const BACK = "https://claude.example/api/mcp/auth_callback";
const MCP = `${origin}/mcp`;
/** An app whose id is the address of a document about it. */
const DOCUMENT = "https://claude.example/oauth/client.json";

const VERIFIER = "a-verifier-only-the-app-that-began-has-0123456789";
let challenge: string;

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

const turn = (session: Session | null, on: unknown) => api("/api/account/outside_ai", { method: "PUT", headers: as(session), body: JSON.stringify({ on }) });

/** Sets Ember up with outside AI on, and Grace in it. */
async function setUpOn(): Promise<{ administrator: Session; member: Session }> {
  const administrator = await setUp();
  expect((await turn(administrator, true)).status).toBe(200);
  return { administrator, member: await joinAsGrace() };
}

const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

const register = (body: unknown, ip = "203.0.113.9") => api("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) });

/** Registers the app, answering the id Ember gives it. */
async function registered(): Promise<string> {
  const response = await register({ client_name: "Claude", redirect_uris: [BACK] });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** The app's request to connect, as the page reads it from its address. */
const askOf = (clientId: string, more: Partial<OutsideAsk> = {}): OutsideAsk => ({
  responseType: "code",
  clientId,
  redirectUri: BACK,
  state: "kept-by-the-app",
  codeChallenge: challenge,
  codeChallengeMethod: "S256",
  scope: "read",
  resource: MCP,
  ...more,
});

const describeAsk = (session: Session | null, ask: unknown) => api("/api/outside/asks", { method: "POST", headers: as(session), body: JSON.stringify(ask) });
const answer = (session: Session | null, ask: unknown, allow: unknown, without?: unknown) =>
  api("/api/outside/answers", { method: "POST", headers: as(session), body: JSON.stringify({ ask, allow, without }) });

/** Where the page sends the browser once `session` allows `ask`, leaving out `without` of what it asks. */
async function allowed(session: Session, ask: OutsideAsk, without?: unknown): Promise<URL> {
  const response = await answer(session, ask, true, without);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return new URL(((await response.json()) as OutsideAnswered).redirectTo);
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

const exchange = (clientId: string, code: string, more: Record<string, string> = {}) =>
  api("/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: VERIFIER, redirect_uri: BACK, resource: MCP, ...more }));
const refresh = (clientId: string, refreshToken: string) => api("/oauth/token", form({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }));

/** Connects the app as `session`, from registering to its tokens, asking as `more` has it, which `session` allows but for `without`. */
async function connected(session: Session, more: Partial<OutsideAsk> = {}, without?: unknown): Promise<{ clientId: string; tokens: Tokens }> {
  const clientId = await registered();
  const back = await allowed(session, askOf(clientId, more), without);
  const response = await exchange(clientId, back.searchParams.get("code")!);
  expect(response.status, await response.clone().text()).toBe(200);
  return { clientId, tokens: await response.json() };
}

/** What Ember answers the app's `method` over the protocol, asked with `token`. */
async function asked(token: string | null, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; challenge: string | null; result?: Record<string, unknown>; error?: unknown }> {
  const response = await api("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token !== null && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const sent = response.headers.get("Content-Type")?.includes("event-stream") ? (text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}") : text;
  const { result, error } = (text === "" ? {} : JSON.parse(sent)) as { result?: Record<string, unknown>; error?: unknown };
  return { status: response.status, challenge: response.headers.get("WWW-Authenticate"), result, error };
}

/** The rooms Ember lists for the app that asks with `token`. */
async function roomsFor(token: string): Promise<Array<{ id: string; kind: string; name: string; unread: boolean }>> {
  const { status, result } = await asked(token, "tools/call", { name: "list_rooms", arguments: {} });
  expect(status).toBe(200);
  const [{ text }] = result!.content as [{ text: string }];
  return (JSON.parse(text) as { rooms: Array<{ id: string; kind: string; name: string; unread: boolean }> }).rooms;
}

/** Whether AI apps may connect, as the workspace's settings tell the person `session` signs in, which is only ever so for an administrator. */
const isOnFor = async (session: Session) => ((await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings).outsideAi;
/** The AI apps connected as the person `session` signs in, as their profile lists them: null when none can be. */
/** What Ember's tool `name` answers the app that asks with `token`, called with `given`. */
async function called(token: string, name: string, given: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const { status, result } = await asked(token, "tools/call", { name, arguments: given });
  expect(status).toBe(200);
  const { content, isError } = result as { content: [{ text: string }]; isError?: boolean };
  return { text: content[0].text, isError };
}

/** What the tool found. */
async function found<Found = unknown>(token: string, name: string, given: Record<string, unknown>): Promise<Found> {
  const { text, isError } = await called(token, name, given);
  expect(isError, text).toBeFalsy();
  return JSON.parse(text) as Found;
}

/** Why the tool couldn't do what it was asked, as it tells the app's model. */
async function refusal(token: string, name: string, given: Record<string, unknown>): Promise<string> {
  const { text, isError } = await called(token, name, given);
  expect(isError, text).toBe(true);
  return text;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until room `room` has nothing left in its log for the search index, which it forgets once the index has taken it. */
async function caughtUp(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/** Replies in `parent`'s thread as `client`, and waits for the room to confirm it. */
async function reply(client: Socket, parent: Pick<Message, "id">, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id, alsoSend: false });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

const yours = async (session: Session) => ((await (await api("/api/users/me/profile", { headers: as(session) })).json()) as ProfileAnswer).profile.outsideAi;
const connections = () => workspaceSql("SELECT count(*) AS n FROM outside_connections") as Promise<Array<{ n: number }>>;
const spentTokens = async () => ((await workspaceSql("SELECT count(*) AS n FROM outside_spent_tokens")) as [{ n: number }])[0].n;

/** The addresses names resolve to, for the lookups Ember makes before it reads a document about an app. */
let addresses: Record<string, string[]>;
/** What's at the address of the document about an app. */
let document: () => Response;

beforeEach(async () => {
  await freshDeploy();
  challenge = toBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER)))).replace(/=+$/, "");
  addresses = { "claude.example": ["93.184.216.34"] };
  document = () => Response.json({ client_id: DOCUMENT, client_name: "Claude", redirect_uris: [BACK, "claude://callback"] });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.hostname !== "cloudflare-dns.com") return url.href === DOCUMENT ? document() : new Response("Not found", { status: 404 });
    const found = url.searchParams.get("type") === "A" ? (addresses[url.searchParams.get("name")!] ?? []) : [];
    return Response.json({ Status: 0, Answer: found.map((data) => ({ type: 1, data })) });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Outside AI", () => {
  it("answers nothing until an administrator turns it on", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) expect((await api(path)).status, path).toBe(404);
    expect((await asked(null, "tools/list")).status).toBe(404);
    expect((await register({ redirect_uris: [BACK] })).status).toBe(404);
    expect((await exchange("an-app", "a-code")).status).toBe(404);
    // Not even to say a request is made wrong.
    expect((await api("/oauth/token", form({ grant_type: "password" }))).status).toBe(404);
    expect((await api("/oauth/revoke", form({ token: "a-token", client_id: "an-app" }))).status).toBe(404);
    expect((await api("/oauth/revoke", form({}))).status).toBe(404);
    // Nor to say how it takes requests.
    expect((await api("/oauth/token")).status).toBe(404);
    expect((await api("/mcp", { method: "OPTIONS" })).status).toBe(404);
    // Nor is the page that asks there: this is the page for what Ember doesn't have, not the app's.
    const missing = await api("/oauth/authorize?client_id=an-app");
    expect([missing.status, missing.headers.get("Link")]).toEqual([404, null]);
    expect(await (await describeAsk(member, askOf("an-app"))).json()).toEqual({ error: OUTSIDE_OFF });
    expect(await yours(member)).toBeNull();

    expect((await turn(null, true)).status).toBe(401);
    expect(await (await turn(member, true)).json()).toEqual({ error: OUTSIDE_FORBIDDEN });
    expect((await turn(administrator, "yes")).status).toBe(422);
    expect(await isOnFor(administrator)).toBe(false);
    expect(await (await turn(administrator, true)).json()).toEqual({ on: true });
    expect(await isOnFor(administrator)).toBe(true);
    expect(await isOnFor(member)).toBe(false);
    expect(await yours(member)).toEqual([]);
    // The app's page, which is what's sent with what the app loads first, whether or not the app has been built here.
    expect((await api("/oauth/authorize?client_id=an-app")).headers.get("Link")).toContain("/api/bootstrap");
    expect((await api("/oauth/revoke", form({}))).status).toBe(400);
    expect((await api("/oauth/token")).status).toBe(405);
    expect((await api("/mcp", { method: "OPTIONS" })).status).toBe(204);
  });

  it("says how to sign in to it, to an app from any origin", async () => {
    await setUpOn();
    const unsigned = await asked(null, "tools/list");
    expect(unsigned.status).toBe(401);
    expect(unsigned.challenge).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`);
    expect((await asked("not-a-token", "tools/list")).challenge).toContain('error="invalid_token"');

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const resource = await api(path);
      expect(resource.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await resource.json()).toEqual({ resource: MCP, authorization_servers: [origin], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_name: "Ember" });
    }
    expect(await (await api("/.well-known/oauth-authorization-server")).json()).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });

    const preflight = await api("/oauth/token", { method: "OPTIONS", headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("content-type");
    expect((await api("/oauth/token")).status).toBe(405);
  });

  it("registers an app that has browsers sent back over https, or to this computer, a few an hour from one address", async () => {
    await setUpOn();
    const response = await register({ client_name: "  Claude  ", redirect_uris: [BACK, "http://localhost:8123/callback"], token_endpoint_auth_method: "client_secret_post" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ client_id: expect.stringMatching(/^[A-Za-z0-9]{32}$/), client_name: "Claude", redirect_uris: [BACK, "http://localhost:8123/callback"], token_endpoint_auth_method: "none" });
    // An app that gives no name goes by where it comes back to.
    expect(await (await register({ redirect_uris: [BACK] })).json()).toMatchObject({ client_name: "claude.example" });

    for (const address of ["javascript:alert(1)", "http://claude.example/callback", "claude://callback", `${BACK}#fragment`, "https://someone:secret@claude.example/callback", 7]) {
      const refused = await register({ redirect_uris: [address] });
      expect(refused.status, String(address)).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
    expect(await (await register({ redirect_uris: [] })).json()).toMatchObject({ error: "invalid_redirect_uri" });
    expect(await (await register("Claude")).json()).toMatchObject({ error: "invalid_client_metadata" });

    for (let n = 0; n < 10; n++) expect((await register({ redirect_uris: [BACK] }, "198.51.100.7")).status).toBe(201);
    expect((await register({ redirect_uris: [BACK] }, "198.51.100.7")).status).toBe(429);
    expect((await register({ redirect_uris: [BACK] }, "198.51.100.8")).status).toBe(201);
  });

  it(`keeps at most ${MAX_OUTSIDE_CLIENTS} apps that registered, forgetting first the old ones nobody is connected through`, async () => {
    const { member } = await setUpOn();
    // As many as it keeps, registered long ago, each with someone part-way through connecting it.
    await workspaceSql(
      `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_OUTSIDE_CLIENTS})
       INSERT INTO outside_clients (id, name, redirect_uris, created_at) SELECT 'app-' || i, 'An app', '[]', '2020-01-01T00:00:00.000Z' FROM n`,
    );
    await workspaceSql(
      `INSERT INTO outside_connections (id, user_id, client_id, client_name, redirect_uri, scope, code_digest, code_challenge, code_expires_at, created_at)
       SELECT 'connection-' || id, '${member.user.id}', id, name, '${BACK}', 'read', 'digest-' || id, 'challenge', '2999-01-01T00:00:00.000Z', created_at FROM outside_clients`,
    );
    const full = await register({ redirect_uris: [BACK] });
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({ error: "temporarily_unavailable" });

    // A connection whose code has expired, or whose refresh token has, keeps no app.
    await workspaceSql("UPDATE outside_connections SET code_expires_at = '2020-01-01T00:00:00.000Z' WHERE client_id <> 'app-1'");
    await workspaceSql("UPDATE outside_connections SET access_digest = 'access', refresh_digest = 'refresh', refresh_expires_at = '2020-01-01T00:00:00.000Z' WHERE client_id = 'app-2'");
    expect((await register({ redirect_uris: [BACK] })).status).toBe(201);
    expect(await workspaceSql("SELECT id FROM outside_clients WHERE created_at < '2021-01-01' ORDER BY id")).toEqual([{ id: "app-1" }]);
  });

  it("leaves no connection behind when one is allowed as outside AI is turned off", async () => {
    const { administrator, member } = await setUpOn();
    for (let round = 0; round < 3; round++) {
      const clientId = await registered();
      const [, answered] = await Promise.all([turn(administrator, false), answer(member, askOf(clientId), true)]);
      // Allowed first, it ended with the rest. Turned off first, there was nothing to allow.
      expect([200, 409, 422]).toContain(answered.status);
      expect((await connections())[0]!.n).toBe(0);
      expect((await turn(administrator, true)).status).toBe(200);
    }
  });

  it("connects an app as the person who allows it, which then lists the rooms they're in", async () => {
    const { administrator, member } = await setUpOn();
    const secret = await createRoom("Secret plans", { closedTo: [administrator.user.id], as: administrator });
    const dm = await direct(member, administrator);
    const clientId = await registered();

    const described = await describeAsk(member, askOf(clientId));
    expect(described.status, await described.clone().text()).toBe(200);
    expect((await described.json()) as OutsideAsked).toEqual({ name: "Claude", comesBackTo: "claude.example", workspace: "Ember", scopes: ["read"] });
    expect((await connections())[0]!.n).toBe(0);

    const back = await allowed(member, askOf(clientId));
    expect(back.origin + back.pathname).toBe(BACK);
    expect(Object.fromEntries(back.searchParams)).toEqual({ code: expect.any(String), state: "kept-by-the-app", iss: origin });
    // Nothing is connected until the app exchanges the code.
    expect(await yours(member)).toEqual([]);

    const response = await exchange(clientId, back.searchParams.get("code")!);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const tokens = (await response.json()) as Tokens;
    expect(tokens).toEqual({ access_token: expect.any(String), refresh_token: expect.any(String), token_type: "Bearer", expires_in: 3600, scope: "read" });
    // Ember keeps no token, only digests of them.
    const [row] = (await workspaceSql("SELECT * FROM outside_connections")) as [Record<string, string | null>];
    for (const kept of Object.values(row)) for (const token of [tokens.access_token, tokens.refresh_token, back.searchParams.get("code")!]) expect(kept).not.toBe(token);

    const initialized = await asked(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Claude", version: "1" } });
    expect(initialized.result).toMatchObject({ serverInfo: { name: "ember" }, capabilities: { tools: expect.anything() } });
    const listed = await asked(tokens.access_token, "tools/list");
    expect((listed.result!.tools as Array<{ name: string }>).map(({ name }) => name)).toContain("list_rooms");

    // She sees her rooms, the direct message by the other person's name, and not a private room she isn't in.
    const rooms = await roomsFor(tokens.access_token);
    expect(rooms.map(({ name, kind }) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "Ada Lovelace", kind: "direct" },
      { name: "general", kind: "open" },
      { name: "random", kind: "open" },
    ]);
    expect(rooms.find(({ kind }) => kind === "direct")!.id).toBe(dm.id);
    expect(rooms.some(({ id }) => id === secret.id)).toBe(false);

    expect(await yours(member)).toEqual([{ id: expect.any(String), name: "Claude", comesBackTo: "claude.example", scopes: ["read"], connectedAt: expect.any(String), usedAt: expect.any(String) }]);
    expect(await yours(administrator)).toEqual([]);
  });

  it("asks only someone signed in, who isn't a guest, about a request it can answer", async () => {
    const { member } = await setUpOn();
    const clientId = await registered();
    expect((await describeAsk(null, askOf(clientId))).status).toBe(401);
    expect((await answer(null, askOf(clientId), true)).status).toBe(401);
    const guest = await signIn("Guest");
    expect(await (await describeAsk(guest, askOf(clientId))).json()).toEqual({ error: OUTSIDE_GUEST });
    expect((await answer(guest, askOf(clientId), true)).status).toBe(403);

    const refusals: Array<Partial<OutsideAsk>> = [
      { clientId: "an-app-ember-never-registered" },
      { clientId: null },
      { responseType: "token" },
      { redirectUri: "https://attacker.example/callback" },
      { redirectUri: "javascript:alert(1)" },
      { redirectUri: null },
      { codeChallenge: null },
      { codeChallengeMethod: "plain" },
      { codeChallengeMethod: null },
      { resource: "https://ember.test/elsewhere" },
      { state: "x".repeat(2049) },
    ];
    for (const refusal of refusals) {
      expect(await (await describeAsk(member, askOf(clientId, refusal))).json(), JSON.stringify(refusal)).toEqual({ error: OUTSIDE_ASK_REFUSED });
      expect((await answer(member, askOf(clientId, refusal), true)).status, JSON.stringify(refusal)).toBe(422);
    }
    expect((await answer(member, askOf(clientId), "yes")).status).toBe(422);
    expect((await connections())[0]!.n).toBe(0);

    // What she doesn't allow goes back to the app saying so, and connects nothing.
    const denied = await answer(member, askOf(clientId), false);
    expect(Object.fromEntries(new URL(((await denied.json()) as OutsideAnswered).redirectTo).searchParams)).toEqual({ error: "access_denied", state: "kept-by-the-app", iss: origin });
    expect((await connections())[0]!.n).toBe(0);
  });

  it("gives tokens only for a code it gave that app, to the app that began, once", async () => {
    const { member } = await setUpOn();
    const clientId = await registered();
    const other = await registered();
    const code = async () => (await allowed(member, askOf(clientId))).searchParams.get("code")!;
    const invalid = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    };

    await invalid(await exchange(clientId, "a-code-ember-never-gave"));
    await invalid(await exchange(other, await code()));
    await invalid(await exchange(clientId, await code(), { code_verifier: "another-verifier-that-is-long-enough-0123456789" }));
    await invalid(await exchange(clientId, await code(), { redirect_uri: "https://claude.example/elsewhere" }));
    await invalid(await exchange(clientId, await code(), { resource: "https://other.example/mcp" }));
    expect(await (await api("/oauth/token", form({ grant_type: "password", client_id: clientId }))).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await api("/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, code: "a-code" }))).json()).toMatchObject({ error: "invalid_request" });

    // A code that has expired is no good.
    const late = await code();
    await workspaceSql("UPDATE outside_connections SET code_expires_at = '2020-01-01T00:00:00.000Z' WHERE access_digest IS NULL");
    await invalid(await exchange(clientId, late));

    // One that comes twice has been copied, so what the first exchange gave ends with it.
    const once = await code();
    const tokens = (await (await exchange(clientId, once)).json()) as Tokens;
    expect((await asked(tokens.access_token, "tools/list")).status).toBe(200);
    await invalid(await exchange(clientId, once));
    expect((await asked(tokens.access_token, "tools/list")).status).toBe(401);
    expect(await yours(member)).toEqual([]);
  });

  it("gives the next tokens for a refresh token, which that replaces, and ends a connection whose refresh token comes twice", async () => {
    const { member } = await setUpOn();
    const { clientId, tokens } = await connected(member);

    const refreshed = await refresh(clientId, tokens.refresh_token);
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect(next).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await asked(tokens.access_token, "tools/list")).status).toBe(401);
    expect((await asked(next.access_token, "tools/list")).status).toBe(200);

    // Another app can't use it, and an access token isn't one.
    expect((await refresh(await registered(), next.refresh_token)).status).toBe(400);
    expect((await refresh(clientId, next.access_token)).status).toBe(400);
    expect((await asked(next.access_token, "tools/list")).status).toBe(200);

    // The first refresh token again: a copy of it is out.
    expect(await (await refresh(clientId, tokens.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
    expect((await asked(next.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(clientId, next.refresh_token)).status).toBe(400);
    expect((await connections())[0]!.n).toBe(0);
    expect(await spentTokens()).toBe(0);
  });

  it("ends a connection when any refresh token it has replaced comes again, however many it has had since", async () => {
    const { member } = await setUpOn();
    const { clientId, tokens: first } = await connected(member);
    const other = await connected(member);
    const second = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
    const third = (await (await refresh(clientId, second.refresh_token)).json()) as Tokens;
    const fourth = (await (await refresh(clientId, third.refresh_token)).json()) as Tokens;
    expect((await asked(fourth.access_token, "tools/list")).status).toBe(200);
    expect(await spentTokens()).toBe(3);

    // The first one, three behind the one it has now.
    expect(await (await refresh(clientId, first.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
    expect((await asked(fourth.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(clientId, fourth.refresh_token)).status).toBe(400);
    expect(await spentTokens()).toBe(0);
    // Another connection of hers is left alone.
    expect((await asked(other.tokens.access_token, "tools/list")).status).toBe(200);
    expect((await connections())[0]!.n).toBe(1);
  });

  it("keeps a replaced refresh token only until it would have expired, and none of a connection that's gone", async () => {
    const { administrator, member } = await setUpOn();
    const { clientId, tokens: first } = await connected(member);
    const second = (await (await refresh(clientId, first.refresh_token)).json()) as Tokens;
    await workspaceSql("UPDATE outside_spent_tokens SET expires_at = '2020-01-01T00:00:00.000Z'");
    // One that would have expired by now is refused like any that's no good, and ends nothing, before it's forgotten or after.
    expect((await refresh(clientId, first.refresh_token)).status).toBe(400);
    expect((await asked(second.access_token, "tools/list")).status).toBe(200);
    expect(await spentTokens()).toBe(1);
    const third = (await (await refresh(clientId, second.refresh_token)).json()) as Tokens;
    expect(await spentTokens()).toBe(1);
    expect((await refresh(clientId, first.refresh_token)).status).toBe(400);
    expect((await asked(third.access_token, "tools/list")).status).toBe(200);

    const [connection] = (await yours(member))!;
    expect((await api(`/api/users/me/outside/${connection!.id}`, { method: "DELETE", headers: as(member) })).status).toBe(200);
    expect(await spentTokens()).toBe(0);

    const again = await connected(member);
    await refresh(again.clientId, again.tokens.refresh_token);
    expect(await spentTokens()).toBe(1);
    expect((await api(`/api/account/users/${member.user.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    expect(await spentTokens()).toBe(0);
  });

  it("binds an app's tokens to the address it names when it exchanges its code, if it named none before", async () => {
    const { member } = await setUpOn();
    const clientId = await registered();
    const code = async () => (await allowed(member, askOf(clientId, { resource: null }))).searchParams.get("code")!;
    const resourceKept = async () => ((await workspaceSql("SELECT resource FROM outside_connections ORDER BY rowid DESC LIMIT 1")) as [{ resource: string | null }])[0].resource;

    const here = (await (await exchange(clientId, await code())).json()) as Tokens;
    expect(await resourceKept()).toBe(MCP);
    expect((await asked(here.access_token, "tools/list")).status).toBe(200);

    // For another Ember, they're no good at this one.
    const elsewhere = (await (await exchange(clientId, await code(), { resource: "https://another-ember.example/mcp" })).json()) as Tokens;
    expect(await resourceKept()).toBe("https://another-ember.example/mcp");
    expect((await asked(elsewhere.access_token, "tools/list")).status).toBe(401);

    // An address that couldn't be an Ember's is refused, and the code is still good.
    const kept = await code();
    const refused = await exchange(clientId, kept, { resource: "https://another-ember.example/elsewhere" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_target" });
    expect((await exchange(clientId, kept)).status).toBe(200);

    // An app that never names one is bound to none.
    const unnamed = await api("/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, code: await code(), code_verifier: VERIFIER, redirect_uri: BACK }));
    expect((await asked(((await unnamed.json()) as Tokens).access_token, "tools/list")).status).toBe(200);
    expect(await resourceKept()).toBeNull();
  });

  it("stops answering a token that has expired, or whose app named another address to use it at", async () => {
    const { member } = await setUpOn();
    const { tokens } = await connected(member);
    await workspaceSql("UPDATE outside_connections SET access_expires_at = '2020-01-01T00:00:00.000Z'");
    expect((await asked(tokens.access_token, "tools/list")).status).toBe(401);

    const clientId = await registered();
    const back = await allowed(member, askOf(clientId, { resource: "https://another-ember.example/mcp" }));
    // Who sent the browser back is still this Ember, whatever the request says it's for.
    expect(back.searchParams.get("iss")).toBe(origin);
    const elsewhere = (await (await exchange(clientId, back.searchParams.get("code")!, { resource: "https://another-ember.example/mcp" })).json()) as Tokens;
    expect((await asked(elsewhere.access_token, "tools/list")).status).toBe(401);
  });

  it("takes an app whose id is the address of a document about it, read from a public address", async () => {
    const { member } = await setUpOn();
    expect(await (await describeAsk(member, askOf(DOCUMENT))).json()).toEqual({ name: "Claude", comesBackTo: "claude.example", workspace: "Ember", scopes: ["read"] });
    const back = await allowed(member, askOf(DOCUMENT));
    const tokens = (await (await exchange(DOCUMENT, back.searchParams.get("code")!)).json()) as Tokens;
    expect(await roomsFor(tokens.access_token)).toHaveLength(2);
    expect((await workspaceSql("SELECT count(*) AS n FROM outside_clients"))[0]).toEqual({ n: 0 });

    // Not where the document doesn't say the app comes back, nor to an address Ember doesn't send browsers.
    expect((await describeAsk(member, askOf(DOCUMENT, { redirectUri: "https://claude.example/elsewhere" }))).status).toBe(422);
    expect((await describeAsk(member, askOf(DOCUMENT, { redirectUri: "claude://callback" }))).status).toBe(422);
    // Nor when the document is about another app, isn't there, or is somewhere that isn't public.
    document = () => Response.json({ client_id: "https://claude.example/another.json", redirect_uris: [BACK] });
    expect((await describeAsk(member, askOf(DOCUMENT))).status).toBe(422);
    document = () => new Response("Not found", { status: 404 });
    expect((await describeAsk(member, askOf(DOCUMENT))).status).toBe(422);
    document = () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/client.json" } });
    expect((await describeAsk(member, askOf(DOCUMENT))).status).toBe(422);
    document = () => Response.json({ client_id: DOCUMENT, redirect_uris: [BACK] });
    addresses["claude.example"] = ["10.0.0.7"];
    expect((await describeAsk(member, askOf(DOCUMENT))).status).toBe(422);
    expect((await describeAsk(member, askOf("https://10.0.0.7/client.json"))).status).toBe(422);
    // Nor one on the computer Ember runs on, which a deployed Ember doesn't so much as ask.
    for (const local of ["https://localhost/client.json", "https://127.0.0.1:8787/client.json", "http://localhost/client.json", "https://app.localhost/client.json"]) {
      expect((await describeAsk(member, askOf(local))).status, local).toBe(422);
    }
    expect(vi.mocked(fetch).mock.calls.map(([input, init]) => new URL(new Request(input, init).url).hostname).filter((host) => /localhost|^127\./.test(host))).toEqual([]);
  });

  it("ends a connection when its person disconnects it, when the app revokes it, and when they're removed", async () => {
    const { administrator, member } = await setUpOn();
    const first = await connected(member);
    const second = await connected(member);
    const [newest, oldest] = (await yours(member))!;
    expect(newest!.connectedAt >= oldest!.connectedAt).toBe(true);

    // Not someone else's to end.
    expect(await (await api(`/api/users/me/outside/${newest!.id}`, { method: "DELETE", headers: as(administrator) })).json()).toEqual({ error: OUTSIDE_CONNECTION_GONE });
    const disconnected = await api(`/api/users/me/outside/${newest!.id}`, { method: "DELETE", headers: as(member) });
    expect(((await disconnected.json()) as YourOutsideAi).connections).toEqual([oldest]);
    expect((await asked(second.tokens.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(second.clientId, second.tokens.refresh_token)).status).toBe(400);
    expect((await asked(first.tokens.access_token, "tools/list")).status).toBe(200);

    // An app revokes its own tokens, not another's.
    expect((await api("/oauth/revoke", form({ token: first.tokens.refresh_token, client_id: second.clientId }))).status).toBe(200);
    expect((await asked(first.tokens.access_token, "tools/list")).status).toBe(200);
    expect((await api("/oauth/revoke", form({ token: first.tokens.refresh_token, client_id: first.clientId }))).status).toBe(200);
    expect((await asked(first.tokens.access_token, "tools/list")).status).toBe(401);
    expect((await api("/oauth/revoke", form({ client_id: first.clientId }))).status).toBe(400);

    const third = await connected(member);
    expect((await api(`/api/account/users/${member.user.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    expect((await asked(third.tokens.access_token, "tools/list")).status).toBe(401);
    expect((await connections())[0]!.n).toBe(0);
  });

  it("ends every connection, and forgets every app, when it's turned off", async () => {
    const { administrator, member } = await setUpOn();
    const { clientId, tokens } = await connected(member);
    expect(await (await turn(administrator, false)).json()).toEqual({ on: false });
    expect((await asked(tokens.access_token, "tools/list")).status).toBe(404);
    expect(await workspaceSql("SELECT (SELECT count(*) FROM outside_connections) + (SELECT count(*) FROM outside_clients) + (SELECT count(*) FROM outside_spent_tokens) AS n")).toEqual([{ n: 0 }]);

    expect((await turn(administrator, true)).status).toBe(200);
    expect((await asked(tokens.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(400);
    expect((await describeAsk(member, askOf(clientId))).status).toBe(422);
  });

  it(`connects at most ${MAX_OUTSIDE_CONNECTIONS} apps as one person`, async () => {
    const { member } = await setUpOn();
    const clientId = await registered();
    for (let n = 0; n < MAX_OUTSIDE_CONNECTIONS; n++) await allowed(member, askOf(clientId));
    const full = await answer(member, askOf(clientId), true);
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: OUTSIDE_FULL });
    // The ones whose codes expired unexchanged make room.
    await workspaceSql("UPDATE outside_connections SET code_expires_at = '2020-01-01T00:00:00.000Z'");
    await allowed(member, askOf(clientId));
    expect((await connections())[0]!.n).toBe(1);
  });
});

describe("What a connected AI app reads", () => {
  /** Grace's connection's token, with Ada's and her sessions, and the rooms the app lists by name. */
  async function reading() {
    const sessions = await setUpOn();
    const { tokens } = await connected(sessions.member);
    const rooms = Object.fromEntries((await roomsFor(tokens.access_token)).map((room) => [room.name, room.id]));
    return { ...sessions, token: tokens.access_token, general: rooms.general! };
  }

  it("offers tools that read, each marked as only reading", async () => {
    const { token } = await reading();
    const { tools } = (await asked(token, "tools/list")).result as { tools: Array<{ name: string; annotations: unknown; inputSchema: { required?: string[] } }> };
    expect(tools.map(({ name }) => name)).toEqual(["list_rooms", "read_room", "read_thread", "search_messages"]);
    for (const { annotations } of tools) expect(annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(tools.map(({ inputSchema }) => inputSchema.required ?? [])).toEqual([[], ["room_id"], ["room_id", "message_id"], ["words"]]);
  });

  it("reads a room's messages a page at a time, oldest first, and a thread's", async () => {
    const { administrator, member, token, general } = await reading();
    const [ada, hopper] = [await connect(general, administrator), await connect(general, member)];
    const written: Message[] = [];
    for (let n = 1; n <= HISTORY_PAGE_SIZE + 2; n++) written.push(await post(ada, `<p>Message ${n}</p>`));
    const last = written.at(-1)!;
    const yes = await reply(hopper, last, "<p>Yes, <strong>ship</strong> it</p>");

    const newest = await found<{ room: unknown; messages: Array<Record<string, unknown>>; older: string | null }>(token, "read_room", { room_id: general });
    expect(newest.room).toEqual({ id: general, kind: "open", name: "general" });
    expect(newest.messages.map(({ text }) => text)).toEqual(written.slice(2).map(({ plainText }) => plainText));
    expect(newest.messages.at(-1)).toEqual({ id: last.id, at: last.createdAt, from: "Ada Lovelace", text: `Message ${HISTORY_PAGE_SIZE + 2}`, replies: 1 });
    expect(newest.messages[0]).toEqual({ id: written[2]!.id, at: written[2]!.createdAt, from: "Ada Lovelace", text: "Message 3" });
    expect(newest.older).toBe(written[2]!.id);

    const older = await found<typeof newest>(token, "read_room", { room_id: general, before: newest.older });
    expect(older.messages.map(({ text }) => text)).toEqual(["Message 1", "Message 2"]);
    expect(older.older).toBeNull();

    const thread = await found<{ message: unknown; replies: unknown[] }>(token, "read_thread", { room_id: general, message_id: last.id });
    expect(thread.message).toEqual(newest.messages.at(-1));
    expect(thread.replies).toEqual([{ id: yes.id, at: yes.createdAt, from: "Grace Hopper", text: "Yes, ship it", reply_to: last.id }]);

    expect(await refusal(token, "read_room", { room_id: general, before: "no-such-message" })).toBe("The room has no message with the id given as `before`.");
    expect(await refusal(token, "read_thread", { room_id: general, message_id: yes.id })).toMatch(/^The room has no message with that id that a thread could be under\./);
    ada.close();
    hopper.close();
  });

  it("reads only the rooms its person is in, their direct messages too", async () => {
    const { administrator, member, token } = await reading();
    const secret = await createRoom("Secret plans", { closedTo: [administrator.user.id], as: administrator });
    const dm = await direct(member, administrator);
    const [inSecret, inDm] = [await connect(secret.id, administrator), await connect(dm.id, administrator)];
    await post(inSecret, "<p>The launch is in March</p>");
    const hello = await post(inDm, "<p>Hello, Grace</p>");

    const NO_ROOM = "No room of theirs has that id. list_rooms lists the rooms they're in.";
    expect(await refusal(token, "read_room", { room_id: secret.id })).toBe(NO_ROOM);
    expect(await refusal(token, "read_thread", { room_id: secret.id, message_id: "any" })).toBe(NO_ROOM);
    expect(await refusal(token, "read_room", { room_id: "no-such-room" })).toBe(NO_ROOM);
    expect(await found(token, "read_room", { room_id: dm.id })).toEqual({
      room: { id: dm.id, kind: "direct", name: "Ada Lovelace" },
      messages: [{ id: hello.id, at: hello.createdAt, from: "Ada Lovelace", text: "Hello, Grace" }],
      older: null,
    });
    inSecret.close();
    inDm.close();
  });

  it("searches the rooms its person is in, newest first, a page at a time, or one of them", async () => {
    const { administrator, member, token, general } = await reading();
    const secret = await createRoom("Secret plans", { closedTo: [administrator.user.id], as: administrator });
    const dm = await direct(member, administrator);
    const [inGeneral, inSecret, inDm] = [await connect(general, administrator), await connect(secret.id, administrator), await connect(dm.id, member)];
    const harvest = await post(inGeneral, "<p>The kumquat harvest is in</p>");
    await post(inSecret, "<p>A secret kumquat</p>");
    const pie = await post(inDm, "<p>Kumquat pie tonight?</p>");
    const quinces: Message[] = [];
    for (let n = 1; n <= MESSAGES_FOUND + 2; n++) quinces.push(await post(inGeneral, `<p>Quince ${n}</p>`));
    await Promise.all([general, secret.id, dm.id].map(caughtUp));

    type Found = { matches: Array<{ room: { id: string; name: string }; id: string; text: string }>; next: number | null };
    const kumquats = await found<Found>(token, "search_messages", { words: "kumquat" });
    expect(kumquats.matches).toEqual([
      { room: { id: dm.id, kind: "direct", name: "Ada Lovelace" }, id: pie.id, at: pie.createdAt, from: "Grace Hopper", text: "Kumquat pie tonight?" },
      { room: { id: general, kind: "open", name: "general" }, id: harvest.id, at: harvest.createdAt, from: "Ada Lovelace", text: "The kumquat harvest is in" },
    ]);
    expect(kumquats.next).toBeNull();
    expect((await found<Found>(token, "search_messages", { words: "kumquat harvest", room_id: general })).matches.map(({ id }) => id)).toEqual([harvest.id]);
    expect((await found<Found>(token, "search_messages", { words: "kumquat", room_id: dm.id })).matches.map(({ id }) => id)).toEqual([pie.id]);
    expect(await found(token, "search_messages", { words: "persimmon" })).toEqual({ matches: [], next: null });

    const newest = await found<Found>(token, "search_messages", { words: "quince" });
    expect(newest.matches.map(({ text }) => text)).toEqual(quinces.slice(2).reverse().map(({ plainText }) => plainText));
    expect(newest.next).toEqual(expect.any(Number));
    const rest = await found<Found>(token, "search_messages", { words: "quince", after: newest.next });
    expect(rest.matches.map(({ text }) => text)).toEqual(["Quince 2", "Quince 1"]);
    expect(rest.next).toBeNull();

    expect(await refusal(token, "search_messages", { words: "kumquat", room_id: secret.id })).toBe("No room of theirs has that id. list_rooms lists the rooms they're in.");
    expect(await refusal(token, "search_messages", { words: " … " })).toBe("Give the words to find, as `words`.");
    expect(await refusal(token, "search_messages", { words: "k".repeat(MAX_SEARCH_LENGTH + 1) })).toBe("That's too much to search for. Give one or two words.");
    for (const socket of [inGeneral, inSecret, inDm]) socket.close();
  });

  it("cuts a long message, and names a file in place of a file message's text", async () => {
    const { administrator, token, general } = await reading();
    const ada = await connect(general, administrator);
    await post(ada, `<p>${"long ".repeat(MAX_SHOWN_LENGTH / 5 + 100)}</p>`);
    const file = await upload(administrator, general, "notes.txt", new TextEncoder().encode("Notes"), "text/plain");

    const { messages } = await found<{ messages: Array<{ id: string; text: string; file?: string }> }>(token, "read_room", { room_id: general });
    const [long, shared] = messages.slice(-2);
    expect(long!.text).toHaveLength(MAX_SHOWN_LENGTH);
    expect(long!.text.endsWith("long…")).toBe(true);
    expect(shared).toMatchObject({ id: file.id, text: "", file: "notes.txt" });
    ada.close();
  });

  it("keeps the text of a bot's message that was given a file, cut as any other, beside the file's name", async () => {
    const { administrator, token, general } = await reading();
    const added = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name: "Build Bot" }) });
    const messages = `/rooms/${general}/${((await added.json()) as BotAnswer).bot.key}/messages`;
    const posted = await api(messages, { method: "POST", body: "long ".repeat(MAX_SHOWN_LENGTH / 5 + 100), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const id = posted.headers.get("Location")!.split("/@")[1]!;
    const form = new FormData();
    form.set("attachment", new File(["Build passed"], "build.log"));
    expect((await api(`${messages}/${id}`, { method: "PATCH", body: form })).status).toBe(200);

    const read = await found<{ messages: Array<{ id: string; text: string; file?: string }> }>(token, "read_room", { room_id: general });
    const attached = read.messages.at(-1)!;
    expect(attached).toMatchObject({ id, from: "Build Bot", file: "build.log" });
    expect(attached.text).toHaveLength(MAX_SHOWN_LENGTH);
    expect(attached.text.endsWith("long…")).toBe(true);
  });
});


describe("What a connected AI app sends", () => {
  type Listed = { tools: Array<{ name: string; annotations: unknown; inputSchema: { required?: string[] } }> };
  type Sent = { room: unknown; message: { id: string; at: string; from: string; text: string; reply_to?: string } };

  /** Grace's connection's token, which she let send, with Ada's and her sessions, and the room everyone's in. */
  async function sending() {
    const sessions = await setUpOn();
    const { tokens } = await connected(sessions.member, { scope: "read write" });
    const rooms = Object.fromEntries((await roomsFor(tokens.access_token)).map((room) => [room.name, room.id]));
    return { ...sessions, token: tokens.access_token, general: rooms.general! };
  }

  const toolsOf = async (token: string) => ((await asked(token, "tools/list")).result as Listed).tools;

  it("offers sending only to a connection whose person let it send, marked as changing things", async () => {
    const { member } = await setUpOn();
    const clientId = await registered();
    expect(((await (await describeAsk(member, askOf(clientId, { scope: "read write" }))).json()) as OutsideAsked).scopes).toEqual(["read", "write"]);

    const both = await connected(member, { scope: "write read" });
    expect(both.tokens.scope).toBe("read write");
    const send = (await toolsOf(both.tokens.access_token)).find(({ name }) => name === "send_message")!;
    expect(send.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(send.inputSchema.required).toEqual(["room_id", "text"]);

    // She leaves sending out, and nothing else can be: reading is what connecting is.
    const reading = await connected(member, { scope: "read write" }, ["write", "read", "admin"]);
    expect(reading.tokens.scope).toBe("read");
    expect((await toolsOf(reading.tokens.access_token)).map(({ name }) => name)).toEqual(["list_rooms", "read_room", "read_thread", "search_messages"]);
    const { status, result, error } = await asked(reading.tokens.access_token, "tools/call", { name: "send_message", arguments: { room_id: "any", text: "Hello" } });
    expect(status).toBe(200);
    expect(error !== undefined || result?.isError === true).toBe(true);

    // An app that doesn't ask to send can't, and one that asks for nothing by name only reads.
    expect((await connected(member)).tokens.scope).toBe("read");
    expect((await connected(member, { scope: null })).tokens.scope).toBe("read");
    // One that asks only to send has nothing left out.
    const only = await connected(member, { scope: "write" }, ["write"]);
    expect(only.tokens.scope).toBe("write");
    expect((await toolsOf(only.tokens.access_token)).map(({ name }) => name)).toEqual(["send_message"]);

    expect((await yours(member))!.map(({ scopes }) => scopes)).toEqual([["write"], ["read"], ["read"], ["read"], ["read", "write"]]);
  });

  it("sends a message as its person, in Markdown, which the room hears as theirs, and replies in a thread", async () => {
    const { administrator, token, general } = await sending();
    const ada = await connect(general, administrator);
    const question = await post(ada, "<p>Shall we ship?</p>");

    const sent = await found<Sent>(token, "send_message", { room_id: general, text: "**Ship** it, @Ada Lovelace: see [the plan](https://example.com/plan)" });
    const { message: heard } = await ada.next("message.created");
    expect(heard).toMatchObject({ id: sent.message.id, creator: { name: "Grace Hopper" }, plainText: "Ship it, @Ada Lovelace: see the plan" });
    expect(heard.body).toContain("<strong>Ship</strong>");
    expect(heard.body).toContain('href="https://example.com/plan"');
    // Markdown mentions nobody, so nobody is called, @ember and the agents included.
    expect(heard.mentions).toEqual([]);
    expect(sent).toEqual({ room: { id: general, kind: "open", name: "general" }, message: { id: heard.id, at: heard.createdAt, from: "Grace Hopper", text: heard.plainText } });

    const answered = await found<Sent>(token, "send_message", { room_id: general, text: "Yes", thread_id: question.id });
    expect(answered.message).toEqual({ id: expect.any(String), at: expect.any(String), from: "Grace Hopper", text: "Yes", reply_to: question.id });
    const thread = await found<{ replies: unknown[] }>(token, "read_thread", { room_id: general, message_id: question.id });
    expect(thread.replies).toEqual([answered.message]);
    ada.close();
  });

  it("sends what it sends to no bot, though it's to a direct message with one, where what its person writes goes to it", async () => {
    const { administrator, member, token } = await sending();
    const added = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name: "Build Bot", webhookUrl: "https://bots.example.com/build" }) });
    const { bot } = (await added.json()) as BotAnswer;
    const room = await direct(member, { user: { id: bot.id, name: bot.name }, cookie: "" });
    const delivered: Array<{ message: { id: string } }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      delivered.push(await new Request(input, init).json());
      return new Response(null, { status: 204 });
    });

    const sent = await found<Sent>(token, "send_message", { room_id: room.id, text: "Build it" });
    expect(sent.message).toMatchObject({ from: "Grace Hopper", text: "Build it" });
    // Her own message, written after, is the only one the bot is sent.
    const grace = await connect(room.id, member);
    const written = await post(grace, "<p>Build it, please</p>");
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await settle(grace);
    expect(delivered.map(({ message }) => message.id)).toEqual([written.id]);
    grace.close();
  });

  it("refuses a message with nothing in it or too much, one to a room that isn't theirs, and a reply to no thread", async () => {
    const { administrator, token, general } = await sending();
    const secret = await createRoom("Secret plans", { closedTo: [administrator.user.id], as: administrator });
    const ada = await connect(general, administrator);
    const question = await post(ada, "<p>Shall we ship?</p>");
    const yes = await reply(ada, question, "<p>Yes</p>");

    expect(await refusal(token, "send_message", { room_id: general, text: "  " })).toBe("Give the message to send, as `text`.");
    expect(await refusal(token, "send_message", { room_id: general, text: "word ".repeat(MAX_MESSAGE_LENGTH) })).toBe(MESSAGE_TOO_LONG);
    // Short enough to read as Markdown, and still more than a message holds.
    expect(await refusal(token, "send_message", { room_id: general, text: "w".repeat(MAX_MESSAGE_LENGTH + 1) })).toBe(MESSAGE_TOO_LONG);
    expect(await refusal(token, "send_message", { room_id: secret.id, text: "Hello" })).toBe("No room of theirs has that id. list_rooms lists the rooms they're in.");
    expect(await refusal(token, "send_message", { room_id: general, text: "Hello", thread_id: "no-such-message" })).toBe("That message no longer exists");
    // A reply has no thread of its own.
    expect(await refusal(token, "send_message", { room_id: general, text: "Hello", thread_id: yes.id })).toBe("That message no longer exists");
    expect(await refusal(token, "send_message", { room_id: general, text: "Hello", thread_id: 7 })).toMatch(/^Input validation error/);
    expect((await found<{ messages: unknown[] }>(token, "read_room", { room_id: general })).messages).toHaveLength(1);
    ada.close();
  });

  it(`sends at most ${OUTSIDE_SENDS_PER_MINUTE} messages as one person in a minute, whichever of their apps sends them`, async () => {
    const { member, token, general } = await sending();
    const other = await connected(member, { scope: "read write" });
    for (let n = 1; n < OUTSIDE_SENDS_PER_MINUTE; n++) await found(token, "send_message", { room_id: general, text: `Message ${n}` });
    await found(other.tokens.access_token, "send_message", { room_id: general, text: "The last" });
    expect(await refusal(token, "send_message", { room_id: general, text: "One more" })).toBe(SENDING_TOO_FAST);
    expect(await refusal(other.tokens.access_token, "send_message", { room_id: general, text: "One more" })).toBe(SENDING_TOO_FAST);
  });
});

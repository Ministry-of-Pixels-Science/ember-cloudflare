import {
  MEMBERFUL_CALLBACK_PATH,
  MEMBERFUL_CONNECTIONS_PATH,
  MEMBERFUL_WEBHOOK_PATH,
  memberfulSignInPath,
  type Bootstrap,
  type Directory,
  type Me,
  type MemberfulConnection,
  type NewWorkspace,
  type UserId,
  type UserStatus,
  type WorkspaceSettings,
} from "@ember/protocol";
import {
  MEMBERFUL_API_KEY_REFUSED,
  MEMBERFUL_API_KEY_UNKNOWN,
  MEMBERFUL_CLIENT_ID_REFUSED,
  MEMBERFUL_CLIENT_SECRET_REFUSED,
  MEMBERFUL_CLIENT_UNKNOWN,
  MEMBERFUL_KEYS_UNCHECKED,
  MEMBERFUL_SITE_REFUSED,
  MEMBERFUL_SITE_UNKNOWN,
  MEMBERFUL_SITE_UNREACHABLE,
  MEMBERFUL_WEBHOOK_SECRET_REFUSED,
  memberfulSiteKept,
  type MemberfulKeysChange,
  type MemberfulSaved,
} from "@ember/protocol/memberful";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex } from "../src/encoding";
import type { Env } from "../src/env";
import { api, apiWith, cookieOf, freshDeploy, origin, shown, withWorkspaceEnv, workspaceSql, type Session } from "./support";

// Set up Memberful, in which an administrator gives Ember a Memberful site's keys, rather than the
// deployment having them as secrets, as memberful.test.ts's does.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

/** The Memberful site an administrator sets up, and another, which the fake Memberful answers for too. */
const SITE = "https://example.memberful.com";
const OTHER_SITE = "https://another.memberful.com";
/** The keys Set up Memberful is given, as Memberful's dashboard shows them. */
const KEYS: MemberfulKeysChange = {
  site: SITE,
  clientId: "a-custom-apps-oauth-identifier",
  clientSecret: "a-custom-apps-oauth-secret",
  apiKey: "a-custom-apps-api-key",
  webhookSecret: "a-webhooks-secret-key",
};
/** The deployment's own keys, as its secrets hold them, for another app at the same site. */
const DEPLOYMENT_KEYS = {
  MEMBERFUL_URL: SITE,
  MEMBERFUL_CLIENT_ID: "the-deployments-oauth-identifier",
  MEMBERFUL_CLIENT_SECRET: "the-deployments-oauth-secret",
  MEMBERFUL_API_KEY: "the-deployments-api-key",
  MEMBERFUL_WEBHOOK_SECRET: "the-deployments-webhook-secret",
};
/** The code Memberful sends the browser back with, and the access token it's exchanged for. */
const CODE = "a-code-from-memberful";
const ACCESS_TOKEN = "an-access-token";
const IP = "203.0.113.20";

/** Katherine, a member of the Memberful site whose subscription is active until a test says otherwise. */
const katherine = { id: "4242", email: "katherine@example.com", fullName: "Katherine Johnson", unrestrictedAccess: false, subscriptions: [{ active: true }] };

/** A request the fake Memberful was sent. */
interface SentToMemberful {
  url: string;
  redirect: string;
  authorization: string | null;
  body: string;
}

/**
 * Stands in for Memberful at `SITE` and `OTHER_SITE`, taking the app's keys `app` has, `KEYS`' unless a
 * test changes them: its admin API answers what it's asked to the API key, and a wrong key with errors,
 * as Memberful does. Its token endpoint answers a code nobody was given `invalid_grant`, or
 * `invalid_client` to keys that aren't the app's, and gives an access token for `CODE`, which its member
 * API describes Katherine to, as `site.member` has her, once `site.meanwhile` has happened, if a test
 * sets it, which the next answer of the member API waits for. `site.answer`, if a test sets it, answers
 * in place of all that. What it's sent goes in `site.requests`.
 */
function fakeMemberful() {
  const site = {
    app: { clientId: KEYS.clientId, clientSecret: KEYS.clientSecret, apiKey: KEYS.apiKey },
    member: { ...katherine },
    answer: null as ((url: URL) => Response | Promise<Response>) | null,
    meanwhile: null as (() => Promise<unknown>) | null,
    requests: [] as SentToMemberful[],
  };
  const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = new TextDecoder().decode(await request.arrayBuffer());
    site.requests.push({ url: request.url, redirect: request.redirect, authorization: request.headers.get("Authorization"), body });
    const url = new URL(request.url);
    if (site.answer) return site.answer(url);
    if (url.origin !== SITE && url.origin !== OTHER_SITE) return new Response("Not found", { status: 404 });
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("client_id") !== site.app.clientId || form.get("client_secret") !== site.app.clientSecret) {
        return Response.json({ error: "invalid_client", error_description: "Client authentication failed." }, { status: 401 });
      }
      if (form.get("grant_type") !== "authorization_code" || form.get("code") !== CODE) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: ACCESS_TOKEN, token_type: "bearer", expires_in: 900 });
    }
    if (url.pathname === "/api/graphql/member" && request.headers.get("Authorization") === `Bearer ${ACCESS_TOKEN}`) {
      const meanwhile = site.meanwhile;
      site.meanwhile = null;
      await meanwhile?.();
      return Response.json({ data: { currentMember: site.member } });
    }
    if (request.method === "POST" && url.pathname === "/api/graphql") {
      if (request.headers.get("Authorization") !== `Bearer ${site.app.apiKey}`) return Response.json({ errors: [{ message: "Invalid authentication token." }] });
      const { query } = JSON.parse(body) as { query: string };
      if (query.includes("members(first: 1)")) return Response.json({ data: { members: { pageInfo: { hasNextPage: false } } } });
      const asked = [...query.matchAll(/(m\d+): member\(id: ("(?:[^"\\]|\\.)*")\)/g)];
      const { member } = site;
      return Response.json({ data: Object.fromEntries(asked.map(([, alias, id]) => [alias, JSON.parse(id!) === member.id ? member : null])) });
    }
    return new Response("Not found", { status: 404 });
  });
  return Object.assign(site, { fetched });
}

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Joins as Grace with the join link, as a member who isn't an administrator. */
async function joinAsGrace(): Promise<Session> {
  const joinCode = ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Gives Ember `keys` as `session`, as Set up Memberful does, on a deployment whose bindings differ from this suite's by `changes`. */
const giveKeys = (session: Session | null, keys: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account/memberful_keys", { method: "PUT", headers: as(session), body: JSON.stringify(keys) });

/** Gives Ember `keys` as `administrator`, which has to work. */
async function saveKeys(administrator: Session, keys: MemberfulKeysChange = KEYS): Promise<MemberfulSaved> {
  const response = await giveKeys(administrator, keys);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as MemberfulSaved;
}

/** Workspace settings as `session` sees them, on a deployment whose bindings differ from this suite's by `changes`. */
const settings = async (session: Session, changes: Partial<Env> = {}) => (await (await apiWith(changes, "/api/account", { headers: as(session) })).json()) as WorkspaceSettings;

/** Memberful as workspace settings show it to `session`. */
async function memberfulOf(session: Session, changes: Partial<Env> = {}): Promise<MemberfulSaved> {
  const { memberfulSite, memberfulWebhooks, memberfulKeys, memberfulSiteKept } = await settings(session, changes);
  return { memberfulSite, memberfulWebhooks, memberfulKeys, memberfulSiteKept };
}

/** Memberful as Set up Memberful leaves it for `site`, while nobody here signs in at it. */
const savedFor = (site: string): MemberfulSaved => ({ memberfulSite: site, memberfulWebhooks: true, memberfulKeys: "saved", memberfulSiteKept: null });

/** Turns Memberful on as `administrator`, members only unless `membersOnly` is false, on a deployment whose bindings differ by `changes`. */
async function turnMemberfulOn(administrator: Session, { membersOnly = false, changes = {} as Partial<Env> } = {}): Promise<Response> {
  return apiWith(changes, "/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ settings: { memberfulJoin: true, memberfulSignIn: membersOnly } }) });
}

const bootstrap = async (changes: Partial<Env> = {}) => (await (await apiWith(changes, "/api/bootstrap")).json()) as Bootstrap;

/** The account's settings, as the database keeps them. */
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;

/** Signs in with Memberful from a new browser, on a deployment whose bindings differ by `changes`, from the start to the callback's answer. */
async function signInWithMemberful(changes: Partial<Env> = {}): Promise<{ authorization: URL; signedIn: Response }> {
  const started = await apiWith(changes, memberfulSignInPath(null), { redirect: "manual" });
  expect(started.status).toBe(302);
  const authorization = new URL(started.headers.get("Location")!);
  const callback = `${MEMBERFUL_CALLBACK_PATH}?${new URLSearchParams({ code: CODE, state: authorization.searchParams.get("state")! })}`;
  const signedIn = await apiWith(changes, callback, { headers: { Cookie: cookieOf(started), "CF-Connecting-IP": IP }, redirect: "manual" });
  return { authorization, signedIn };
}

/** Whom the callback's answer signs the browser in as. */
async function signedInAs(response: Response): Promise<Me> {
  expect(response.status).toBe(302);
  const answer = await api("/api/me", { headers: { Cookie: cookieOf(response) } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { user: Me }).user;
}

/** The hex HMAC-SHA256 of `body` under `secret`, as Memberful signs a webhook. */
async function signatureOf(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
}

/** Memberful's webhook that Katherine's subscription changed, signed with `secret`. */
async function webhook(secret: string): Promise<Response> {
  const body = JSON.stringify({ event: "subscription.deactivated", subscription: { id: 101, active: false, member: { id: Number(katherine.id) } } });
  return api(MEMBERFUL_WEBHOOK_PATH, { method: "POST", headers: { "Content-Type": "application/json", "X-Memberful-Webhook-Signature": await signatureOf(body, secret) }, body });
}

/** Someone's status as the people directory lists it to `viewer`. */
async function statusOf(viewer: Session, id: UserId): Promise<UserStatus | undefined> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === id)?.status;
}

const queuedChecks = () => workspaceSql("SELECT subject FROM membership_checks");

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Set up Memberful", () => {
  it("keeps a Memberful site's keys once Memberful takes them, their secrets sealed, which no page is shown again", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const site = fakeMemberful();
    const response = await giveKeys(administrator, { ...KEYS, site: " example.memberful.com/admin ", clientId: ` ${KEYS.clientId}`, apiKey: `${KEYS.apiKey}\n` });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(savedFor(SITE));

    // Memberful was asked about the API key, then the OAuth keys, with a code nobody was given, never following a redirect.
    expect(site.requests).toEqual([
      { url: `${SITE}/api/graphql`, redirect: "manual", authorization: `Bearer ${KEYS.apiKey}`, body: JSON.stringify({ query: "{ members(first: 1) { pageInfo { hasNextPage } } }" }) },
      { url: `${SITE}/oauth/token`, redirect: "manual", authorization: null, body: expect.stringContaining("grant_type=authorization_code") as unknown as string },
    ]);
    const exchange = new URLSearchParams(site.requests[1]!.body);
    expect([exchange.get("client_id"), exchange.get("client_secret")]).toEqual([KEYS.clientId, KEYS.clientSecret]);
    expect(exchange.get("code")).not.toBe(CODE);

    // The database holds the secrets sealed together, never as they were given, and no page is given them.
    const stored = (await storedSettings()).memberful_keys as { site: string; client_id: string; secrets: string };
    expect(stored).toEqual({ site: SITE, client_id: KEYS.clientId, secrets: expect.stringMatching(/^v1\.[\w-]{16}\.[\w-]+$/) as unknown });
    const everything = JSON.stringify([await workspaceSql("SELECT * FROM accounts"), await settings(administrator), await settings(member), await bootstrap()]);
    for (const secret of [KEYS.clientSecret, KEYS.apiKey, KEYS.webhookSecret]) expect(everything).not.toContain(secret);
    expect(await memberfulOf(administrator)).toEqual(savedFor(SITE));
    expect(await memberfulOf(member)).toEqual(savedFor(SITE));

    // Given again, they're sealed afresh.
    await saveKeys(administrator);
    expect(((await storedSettings()).memberful_keys as typeof stored).secrets).not.toBe(stored.secrets);
  });

  it("takes a site's name alone as its address at memberful.com, which Memberful is asked at and Ember keeps", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    expect(await saveKeys(administrator, { ...KEYS, site: " Example " })).toEqual(savedFor(SITE));
    expect(site.requests.map(({ url }) => url)).toEqual([`${SITE}/api/graphql`, `${SITE}/oauth/token`]);
    expect(((await storedSettings()).memberful_keys as { site: string }).site).toBe(SITE);
    // Nothing else is taken as a site's name.
    const refused = await giveKeys(administrator, { ...KEYS, site: "my site" });
    expect(await refused.json()).toEqual({ error: MEMBERFUL_SITE_REFUSED, field: "site" });
  });

  it("lets Memberful be turned on once it has the keys, without the deployment's secrets", async () => {
    const administrator = await setUp();
    fakeMemberful();
    expect((await turnMemberfulOn(administrator)).status).toBe(422);
    await saveKeys(administrator);
    expect((await bootstrap()).signInWithMemberful).toBe(false);
    const on = await turnMemberfulOn(administrator, { membersOnly: true });
    expect(on.status, await on.clone().text()).toBe(200);
    expect((await bootstrap()).signInWithMemberful).toBe(true);
  });

  it("says why keys aren't kept, on the field they're about, asking Memberful nothing of keys that can't be one", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    const refusals: Array<[unknown, keyof MemberfulKeysChange, string]> = [
      [{ ...KEYS, site: "" }, "site", MEMBERFUL_SITE_REFUSED],
      [{ ...KEYS, site: 42 }, "site", MEMBERFUL_SITE_REFUSED],
      [{ ...KEYS, site: "http://example.memberful.com" }, "site", MEMBERFUL_SITE_REFUSED],
      [{ ...KEYS, site: "https://ada:secret@example.memberful.com" }, "site", MEMBERFUL_SITE_REFUSED],
      [{ ...KEYS, site: "ftp://example.memberful.com" }, "site", MEMBERFUL_SITE_REFUSED],
      [{ ...KEYS, site: "example memberful com" }, "site", MEMBERFUL_SITE_REFUSED],
      [{ ...KEYS, clientId: "" }, "clientId", MEMBERFUL_CLIENT_ID_REFUSED],
      [{ ...KEYS, clientId: "two words" }, "clientId", MEMBERFUL_CLIENT_ID_REFUSED],
      [{ ...KEYS, clientId: "x".repeat(256) }, "clientId", MEMBERFUL_CLIENT_ID_REFUSED],
      [{ ...KEYS, clientSecret: " " }, "clientSecret", MEMBERFUL_CLIENT_SECRET_REFUSED],
      [{ ...KEYS, apiKey: ["a-custom-apps-api-key"] }, "apiKey", MEMBERFUL_API_KEY_REFUSED],
      [{ ...KEYS, webhookSecret: undefined }, "webhookSecret", MEMBERFUL_WEBHOOK_SECRET_REFUSED],
      [null, "site", MEMBERFUL_SITE_REFUSED],
    ];
    for (const [keys, field, error] of refusals) {
      const response = await giveKeys(administrator, keys);
      expect(response.status, JSON.stringify(keys)).toBe(422);
      expect(await response.json()).toEqual({ error, field });
    }
    expect(site.requests).toEqual([]);
    expect((await storedSettings()).memberful_keys).toBeUndefined();
  });

  it("says what Memberful made of the keys, keeping none it didn't take, and logs what it answered but never a key", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = async (keys: MemberfulKeysChange, status: number, refusal: { error: string; field?: string }) => {
      const response = await giveKeys(administrator, keys);
      expect(response.status, refusal.error).toBe(status);
      expect(await response.json()).toEqual(refusal);
    };

    await refused({ ...KEYS, apiKey: "another-api-key" }, 422, { error: MEMBERFUL_API_KEY_UNKNOWN, field: "apiKey" });
    // The token endpoint isn't asked once the API key is refused.
    expect(site.requests.map(({ url }) => url)).toEqual([`${SITE}/api/graphql`]);
    await refused({ ...KEYS, clientSecret: "another-oauth-secret" }, 422, { error: MEMBERFUL_CLIENT_UNKNOWN, field: "clientSecret" });
    await refused({ ...KEYS, clientId: "another-oauth-identifier" }, 422, { error: MEMBERFUL_CLIENT_UNKNOWN, field: "clientSecret" });
    // A site that isn't Memberful's answers otherwise: nothing there, a page, or a redirect.
    await refused({ ...KEYS, site: "https://example.com" }, 422, { error: MEMBERFUL_SITE_UNKNOWN, field: "site" });
    site.answer = () => new Response("<!doctype html><title>Welcome</title>", { headers: { "Content-Type": "text/html" } });
    await refused(KEYS, 422, { error: MEMBERFUL_SITE_UNKNOWN, field: "site" });
    site.answer = () => new Response(null, { status: 301, headers: { Location: "https://memberful.com/" } });
    await refused(KEYS, 422, { error: MEMBERFUL_SITE_UNKNOWN, field: "site" });
    site.answer = () => Response.json({ data: { viewer: null } });
    await refused(KEYS, 422, { error: MEMBERFUL_SITE_UNKNOWN, field: "site" });
    // Nothing at the address, or Cloudflare finding no host there.
    site.answer = () => Promise.reject(new TypeError("fetch failed"));
    await refused(KEYS, 422, { error: MEMBERFUL_SITE_UNREACHABLE, field: "site" });
    site.answer = () => new Response("error code: 1016", { status: 530 });
    await refused(KEYS, 422, { error: MEMBERFUL_SITE_UNREACHABLE, field: "site" });
    // Memberful down, or too slow, or saying to slow down, says nothing of the keys.
    for (const answer of [() => new Response("Bad gateway", { status: 502 }), () => new Response(null, { status: 429 }), () => Promise.reject(new DOMException("timed out", "TimeoutError"))]) {
      site.answer = answer;
      await refused(KEYS, 502, { error: MEMBERFUL_KEYS_UNCHECKED });
    }
    // Nor does its token endpoint not answering, once the admin API has.
    site.answer = (url) => (url.pathname === "/oauth/token" ? new Response("Service unavailable", { status: 503 }) : Response.json({ data: { members: { pageInfo: { hasNextPage: true } } } }));
    await refused(KEYS, 502, { error: MEMBERFUL_KEYS_UNCHECKED });
    // Or answering anything but that the code is no good, which it says only of the app's: a page, a
    // redirect, no OAuth error, or another, which can come before it checks the keys.
    for (const token of [
      () => new Response("<!doctype html><title>Sign in</title>", { headers: { "Content-Type": "text/html" } }),
      () => new Response(null, { status: 302, headers: { Location: `${SITE}/auth/sign_in` } }),
      () => Response.json({}, { status: 400 }),
      () => Response.json({ error: "invalid_request" }, { status: 400 }),
      () => Response.json({ error: "unauthorized_client" }, { status: 400 }),
    ]) {
      site.answer = (url) => (url.pathname === "/oauth/token" ? token() : Response.json({ data: { members: { pageInfo: { hasNextPage: true } } } }));
      await refused(KEYS, 502, { error: MEMBERFUL_KEYS_UNCHECKED });
    }

    expect((await storedSettings()).memberful_keys).toBeUndefined();
    expect(await memberfulOf(administrator)).toEqual({ memberfulSite: null, memberfulWebhooks: false, memberfulKeys: null, memberfulSiteKept: null });
    expect(logged).toHaveBeenCalledWith("Memberful's admin endpoint answered 404 to the keys Set up Memberful was given");
    expect(logged).toHaveBeenCalledWith("Memberful's token endpoint answered 401 to the keys Set up Memberful was given");
    const said = JSON.stringify(logged.mock.calls);
    for (const key of ["another-api-key", "another-oauth-secret", KEYS.clientSecret, KEYS.apiKey, KEYS.webhookSecret]) expect(said).not.toContain(key);
  });

  it("lets only administrators give Ember Memberful's keys, asking Memberful nothing for anyone else", async () => {
    await setUp();
    const member = await joinAsGrace();
    const site = fakeMemberful();
    expect((await giveKeys(member, KEYS)).status).toBe(403);
    expect((await giveKeys(null, KEYS)).status).toBe(401);
    expect(site.requests).toEqual([]);
    expect((await storedSettings()).memberful_keys).toBeUndefined();
  });

  it("signs members in with the keys given, at the site they're for", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    await saveKeys(administrator);
    expect((await turnMemberfulOn(administrator)).status).toBe(200);
    const { authorization, signedIn } = await signInWithMemberful();
    expect(authorization.origin + authorization.pathname).toBe(`${SITE}/oauth`);
    expect(authorization.searchParams.get("client_id")).toBe(KEYS.clientId);
    expect((await signedInAs(signedIn)).name).toBe(katherine.fullName);
    const exchange = new URLSearchParams(site.requests.find(({ url, body }) => url === `${SITE}/oauth/token` && body.includes(CODE))!.body);
    expect([exchange.get("client_id"), exchange.get("client_secret")]).toEqual([KEYS.clientId, KEYS.clientSecret]);
    expect(await workspaceSql("SELECT issuer, subject FROM identities")).toEqual([{ issuer: SITE, subject: katherine.id }]);
  });

  it("hears the site's webhooks with the secret key given, and checks memberships with the API key given", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    await saveKeys(administrator);
    expect((await turnMemberfulOn(administrator)).status).toBe(200);
    const katherineId = (await signedInAs((await signInWithMemberful()).signedIn)).id;

    expect((await webhook(DEPLOYMENT_KEYS.MEMBERFUL_WEBHOOK_SECRET)).status).toBe(401);
    site.member = { ...katherine, subscriptions: [{ active: false }] };
    expect((await webhook(KEYS.webhookSecret)).status).toBe(200);
    await vi.waitFor(async () => expect(await queuedChecks()).toEqual([]), { timeout: 5_000 });
    expect(await statusOf(administrator, katherineId)).toBe("suspended");
    expect(site.requests.filter(({ url, body }) => url === `${SITE}/api/graphql` && body.includes("member(id:")).map(({ authorization }) => authorization)).toEqual([
      `Bearer ${KEYS.apiKey}`,
    ]);
  });

  it("has the deployment's keys take the place of the ones given, while it has its own", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    await saveKeys(administrator);
    const secret: MemberfulSaved = { memberfulSite: SITE, memberfulWebhooks: true, memberfulKeys: "secret", memberfulSiteKept: null };
    expect(await memberfulOf(administrator, DEPLOYMENT_KEYS)).toEqual(secret);
    expect(await memberfulOf(administrator, { ...DEPLOYMENT_KEYS, MEMBERFUL_API_KEY: undefined })).toEqual({ ...secret, memberfulWebhooks: false });
    expect((await turnMemberfulOn(administrator, { changes: DEPLOYMENT_KEYS })).status).toBe(200);
    site.app = { clientId: DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_ID, clientSecret: DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_SECRET, apiKey: DEPLOYMENT_KEYS.MEMBERFUL_API_KEY };
    const { authorization, signedIn } = await signInWithMemberful(DEPLOYMENT_KEYS);
    expect(authorization.searchParams.get("client_id")).toBe(DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_ID);
    expect((await signedInAs(signedIn)).name).toBe(katherine.fullName);

    // Keys given while it has its own say so, and wait for when it hasn't.
    site.app = { clientId: KEYS.clientId, clientSecret: KEYS.clientSecret, apiKey: KEYS.apiKey };
    const changed = await giveKeys(administrator, { ...KEYS, webhookSecret: "a-new-secret-key" }, DEPLOYMENT_KEYS);
    expect(await changed.json()).toEqual(secret);
    expect(await memberfulOf(administrator)).toEqual({ ...savedFor(SITE), memberfulSiteKept: SITE });
  });

  it("keeps the site once anyone here signs in with an account there, which another site's members would never be", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    fakeMemberful();
    // While nobody signs in with Memberful, the site can change.
    await saveKeys(administrator, { ...KEYS, site: OTHER_SITE });
    expect(await memberfulOf(administrator)).toEqual(savedFor(OTHER_SITE));
    await saveKeys(administrator);
    expect((await turnMemberfulOn(administrator)).status).toBe(200);
    await signedInAs((await signInWithMemberful()).signedIn);

    expect(await memberfulOf(administrator)).toEqual({ ...savedFor(SITE), memberfulSiteKept: SITE });
    expect((await memberfulOf(member)).memberfulSiteKept).toBeNull();
    const moved = await giveKeys(administrator, { ...KEYS, site: OTHER_SITE });
    expect(moved.status).toBe(422);
    expect(await moved.json()).toEqual({ error: memberfulSiteKept(SITE), field: "site" });
    expect(((await storedSettings()).memberful_keys as { site: string }).site).toBe(SITE);
    // Its keys still change, however its address is given.
    expect(await saveKeys(administrator, { ...KEYS, webhookSecret: "a-new-secret-key" })).toEqual({ ...savedFor(SITE), memberfulSiteKept: SITE });
    for (const given of ["example", "example.memberful.com/", "HTTPS://EXAMPLE.memberful.com/admin"]) {
      expect(await saveKeys(administrator, { ...KEYS, site: given }), given).toEqual({ ...savedFor(SITE), memberfulSiteKept: SITE });
    }
  });

  it("keeps the site the deployment's keys had people sign in at, once it has none of its own", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    site.app = { clientId: DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_ID, clientSecret: DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_SECRET, apiKey: DEPLOYMENT_KEYS.MEMBERFUL_API_KEY };
    expect((await turnMemberfulOn(administrator, { changes: DEPLOYMENT_KEYS })).status).toBe(200);
    await signedInAs((await signInWithMemberful(DEPLOYMENT_KEYS)).signedIn);

    site.app = { clientId: KEYS.clientId, clientSecret: KEYS.clientSecret, apiKey: KEYS.apiKey };
    expect(await memberfulOf(administrator)).toEqual({ memberfulSite: null, memberfulWebhooks: false, memberfulKeys: null, memberfulSiteKept: SITE });
    const moved = await giveKeys(administrator, { ...KEYS, site: OTHER_SITE });
    expect(await moved.json()).toEqual({ error: memberfulSiteKept(SITE), field: "site" });
    // The site's name alone is the address MEMBERFUL_URL gave, so its members stay linked.
    expect(await saveKeys(administrator, { ...KEYS, site: "example" })).toEqual({ ...savedFor(SITE), memberfulSiteKept: SITE });
    // Who signed in with the deployment's keys signs in with the ones given.
    expect((await signedInAs((await signInWithMemberful()).signedIn)).name).toBe(katherine.fullName);
    expect(await workspaceSql("SELECT count(*) AS n FROM users")).toEqual([{ n: 2 }]);
  });

  it("keeps the site the deployment's keys had people sign in at over one given before them, where nobody signs in", async () => {
    const administrator = await setUp();
    const site = fakeMemberful();
    await saveKeys(administrator, { ...KEYS, site: OTHER_SITE });
    site.app = { clientId: DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_ID, clientSecret: DEPLOYMENT_KEYS.MEMBERFUL_CLIENT_SECRET, apiKey: DEPLOYMENT_KEYS.MEMBERFUL_API_KEY };
    // The Workspace has the deployment's secrets too, as it does deployed.
    await withWorkspaceEnv(DEPLOYMENT_KEYS, async () => {
      expect((await turnMemberfulOn(administrator, { changes: DEPLOYMENT_KEYS })).status).toBe(200);
      await signedInAs((await signInWithMemberful(DEPLOYMENT_KEYS)).signedIn);
    });

    site.app = { clientId: KEYS.clientId, clientSecret: KEYS.clientSecret, apiKey: KEYS.apiKey };
    expect(await memberfulOf(administrator)).toEqual({ ...savedFor(OTHER_SITE), memberfulSiteKept: SITE });
    const kept = await giveKeys(administrator, { ...KEYS, site: OTHER_SITE });
    expect(await kept.json()).toEqual({ error: memberfulSiteKept(SITE), field: "site" });
    expect(await saveKeys(administrator)).toEqual({ ...savedFor(SITE), memberfulSiteKept: SITE });
    expect((await signedInAs((await signInWithMemberful()).signedIn)).name).toBe(katherine.fullName);
  });

  it("links nobody at a site whose keys another site's took the place of while Memberful said who signed in there", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const site = fakeMemberful();
    await saveKeys(administrator);
    expect((await turnMemberfulOn(administrator)).status).toBe(200);
    const elsewhere = () => saveKeys(administrator, { ...KEYS, site: OTHER_SITE });

    // Someone new signing in.
    site.meanwhile = elsewhere;
    const { signedIn } = await signInWithMemberful();
    expect(signedIn.headers.get("Location")).toBe(`${origin}/session/new?memberful=failed`);
    expect(await workspaceSql("SELECT issuer FROM identities")).toEqual([]);
    expect(await memberfulOf(administrator)).toEqual(savedFor(OTHER_SITE));
    // Trying again signs in at the site given.
    const again = await api(memberfulSignInPath(null), { redirect: "manual" });
    expect(new URL(again.headers.get("Location")!).origin).toBe(OTHER_SITE);

    // Someone connecting their account, while Memberful is members only.
    await saveKeys(administrator);
    expect((await turnMemberfulOn(administrator, { membersOnly: true })).status).toBe(200);
    const body = JSON.stringify({ currentPassword: grace.password });
    const started = await api(MEMBERFUL_CONNECTIONS_PATH, { method: "POST", headers: { ...as(member), "CF-Connecting-IP": IP }, body });
    expect(started.status, await started.clone().text()).toBe(202);
    const state = new URL(((await started.json()) as MemberfulConnection).memberfulConnection).searchParams.get("state")!;
    site.meanwhile = elsewhere;
    const callback = `${MEMBERFUL_CALLBACK_PATH}?${new URLSearchParams({ code: CODE, state })}`;
    const connected = await api(callback, { headers: { Cookie: `${cookieOf(started)}; ${member.cookie}`, "CF-Connecting-IP": IP }, redirect: "manual" });
    expect(connected.headers.get("Location")).toBe(`${origin}/users/me/profile?memberful=failed`);
    expect(await workspaceSql("SELECT issuer FROM identities")).toEqual([]);
    expect(await memberfulOf(administrator)).toEqual(savedFor(OTHER_SITE));
  });

  it("uses no keys sealed under another SESSION_SECRET, which it logs", async () => {
    const administrator = await setUp();
    fakeMemberful();
    await saveKeys(administrator);
    expect((await turnMemberfulOn(administrator)).status).toBe(200);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await withWorkspaceEnv({ SESSION_SECRET: "another secret, after the keys were sealed" }, async () => {
      expect(await memberfulOf(administrator)).toEqual({ memberfulSite: null, memberfulWebhooks: false, memberfulKeys: null, memberfulSiteKept: null });
      expect((await bootstrap()).signInWithMemberful).toBe(false);
    });
    expect(logged).toHaveBeenCalledWith("The Memberful keys Ember was given don't open under SESSION_SECRET, so they aren't used.");
    expect(await memberfulOf(administrator)).toEqual(savedFor(SITE));
  });
});

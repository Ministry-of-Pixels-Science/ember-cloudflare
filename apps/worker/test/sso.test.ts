import {
  MEMBERFUL_CALLBACK_PATH,
  MEMBERFUL_CONNECTIONS_PATH,
  memberfulSignInPath,
  type AccountSettings,
  type Bootstrap,
  type Directory,
  type Me,
  type MemberfulConnection,
  type NewWorkspace,
  type ProfileAnswer,
  type Sidebar,
  type UserId,
  type UserStatus,
} from "@ember/protocol";
import {
  ISSUER_MISMATCH,
  ISSUER_UNREACHABLE,
  ISSUER_UNSUPPORTED,
  CLIENT_SECRET_REFUSED,
  MEMBERFUL_OR_SSO_SIGN_IN_NEEDED,
  MEMBERFUL_WITH_SSO,
  OPEN_WITH_SSO,
  PASSWORD_WITH_SSO,
  SSO_CALLBACK_PATH,
  SSO_CONNECTIONS_PATH,
  SSO_DISCONNECT_WITHOUT_PASSWORD,
  SSO_FORBIDDEN,
  SSO_LOGOUT_PATH,
  SSO_SETTINGS_PATH,
  SSO_SETUP_NEEDED,
  SSO_SIGN_IN_NEEDED,
  SSO_WITH_MEMBERFUL,
  ssoSignInPath,
  type SsoConnection,
  type SsoSaved,
  type SsoSettings,
} from "@ember/protocol/sso";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { toBase64url } from "../src/encoding";
import { forgetProviders } from "../src/oidc";
import { SSO_GIVE_UP_MS, type Workspace } from "../src/workspace";
import { api, apiWith, cookieOf, freshDeploy, origin, shown, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

// Single sign-on against a fake OpenID Connect provider, which signs its tokens with keys made for the
// suite, as Zitadel, Keycloak or any other provider would.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

const ISSUER = "https://id.example.com";
const CLIENT_ID = "ember-app";
const CLIENT_SECRET = "ember-app-secret";
const AUTHORIZE = `${ISSUER}/oauth/v2/authorize`;
const TOKEN = `${ISSUER}/oauth/v2/token`;
const KEYS = `${ISSUER}/oauth/v2/keys`;
const USERINFO = `${ISSUER}/oidc/v1/userinfo`;
const BACKCHANNEL_LOGOUT = "http://schemas.openid.net/event/backchannel-logout";
/** Where sign-ins come from, unless a test says otherwise. */
const IP = "203.0.113.30";

/** Someone as the provider describes them. */
interface Person {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
  [claim: string]: unknown;
}

const katherine: Person = { sub: "user-4242", name: "Katherine Johnson", email: "katherine@example.com", email_verified: true, groups: ["staff"] };
const dorothy: Person = { sub: "user-4243", name: "Dorothy Vaughan", email: "dorothy@example.com", email_verified: true, groups: ["visitors"] };
/** Grace's account at the provider, with the email address she has here. */
const gracesAccount: Person = { sub: "user-4250", name: "Grace B. Hopper", email: grace.emailAddress, email_verified: true, groups: ["staff"] };

/** A signing key of the provider's, with the id its tokens name it by. */
interface SigningKey {
  kid: string;
  pair: CryptoKeyPair;
}

let firstKey: SigningKey;
let nextKey: SigningKey;
/** A key nobody published, with the first key's id, as a forger's would be. */
let forgedKey: SigningKey;

const newKey = async (kid: string): Promise<SigningKey> => ({
  kid,
  pair: (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair,
});

beforeAll(async () => {
  [firstKey, nextKey, forgedKey] = await Promise.all([newKey("key-1"), newKey("key-2"), newKey("key-1")]);
});

const encoder = new TextEncoder();
const encoded = (value: unknown) => toBase64url(encoder.encode(JSON.stringify(value)));

/** A JWT of `claims` that `key` signs, with the header `typ`. */
async function signed(key: SigningKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${encoded({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${encoded(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, encoder.encode(input)));
  return `${input}.${toBase64url(signature)}`;
}

const now = () => Math.floor(Date.now() / 1000);
const random = () => crypto.randomUUID();
const challengeOf = async (verifier: string) => toBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));

/** A request the fake provider was sent. */
interface SentToProvider {
  method: string;
  url: string;
  redirect: string;
  body: string;
}

/**
 * Stands in for the provider: its discovery document, as `provider.discovery` changes it, its keys,
 * `provider.keys`, and its authorization endpoint, which `provider.authorize` plays the browser's visit to,
 * signing in `provider.signingIn` with the provider's session `provider.sid`. Its token endpoint takes
 * each code once, with the app's secret, the redirect URI and the PKCE verifier it was given for, and
 * gives an ID token signed with `provider.signWith`, with `provider.idToken`'s claims over its own, and a
 * refresh token, but to a sign-in while `provider.signInWithoutRefreshToken`, which it takes once, for
 * whoever it was given to, unless they're in `provider.revoked`, each grant once what
 * `provider.exchanging` or `provider.refreshing` waits for is done.
 * Its userinfo endpoint describes whoever an access token is for, as `provider.people` has them now.
 * While `provider.down`, nothing answers.
 */
function fakeProvider() {
  const provider = {
    signingIn: katherine,
    sid: "provider-session-1",
    people: new Map<string, Person>(),
    discovery: {} as Record<string, unknown>,
    keys: [firstKey],
    signWith: firstKey,
    idToken: {} as Record<string, unknown>,
    /** An ID token the token endpoint gives instead of one it makes, as a forger's would be. */
    givenIdToken: null as string | null,
    revoked: new Set<string>(),
    /** Whether a refresh gives no ID token, as some providers' don't, leaving the userinfo endpoint's word. */
    refreshWithoutIdToken: false,
    /** Whether signing in gives no refresh token, as Google gives one only when someone first consents. */
    signInWithoutRefreshToken: false,
    /** What a refresh waits for before it's answered, as a slow provider's is, or null to answer at once. */
    refreshing: null as Promise<void> | null,
    /** What exchanging a sign-in's code waits for, as `refreshing` is for a refresh. */
    exchanging: null as Promise<void> | null,
    /** Whether the userinfo endpoint fails, while the rest of the provider answers. */
    userinfoDown: false,
    down: false,
    requests: [] as SentToProvider[],
    codes: new Map<string, { sub: string; sid: string; nonce: string; challenge: string; redirectUri: string }>(),
    accessTokens: new Map<string, string>(),
    refreshTokens: new Map<string, { sub: string; sid: string }>(),
    /** Plays the browser's visit to `location`, the authorization endpoint, signing in whoever `signingIn` is: the code it sends the browser back with. */
    authorize(location: string): string {
      const url = new URL(location);
      expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
      const params = url.searchParams;
      expect(params.get("client_id")).toBe(CLIENT_ID);
      expect(params.get("code_challenge_method")).toBe("S256");
      const code = `code-${random()}`;
      provider.people.set(provider.signingIn.sub, provider.signingIn);
      provider.codes.set(code, { sub: provider.signingIn.sub, sid: provider.sid, nonce: params.get("nonce")!, challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")! });
      return code;
    },
  };

  async function tokensFor(sub: string, sid: string, nonce: string | null): Promise<Response> {
    const [accessToken, refreshToken] = [`at-${random()}`, `rt-${random()}`];
    provider.accessTokens.set(accessToken, sub);
    const refreshes = nonce === null || !provider.signInWithoutRefreshToken;
    if (refreshes) provider.refreshTokens.set(refreshToken, { sub, sid });
    const person = provider.people.get(sub)!;
    const claims = { ...person, iss: ISSUER, aud: CLIENT_ID, iat: now(), exp: now() + 3600, sid, ...(nonce === null ? {} : { nonce }), ...provider.idToken };
    const idToken = nonce === null && provider.refreshWithoutIdToken ? undefined : (provider.givenIdToken ?? (await signed(provider.signWith, claims)));
    return Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, id_token: idToken, refresh_token: refreshes ? refreshToken : undefined });
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    // Read as bytes, which workerd doesn't warn of for a form, as it does reading one as text.
    const body = new TextDecoder().decode(await request.arrayBuffer());
    provider.requests.push({ method: request.method, url: request.url, redirect: request.redirect, body });
    if (provider.down) return new Response("Bad gateway", { status: 502 });
    const url = request.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: AUTHORIZE,
        token_endpoint: TOKEN,
        jwks_uri: KEYS,
        userinfo_endpoint: USERINFO,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        authorization_response_iss_parameter_supported: true,
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
        ...provider.discovery,
      });
    }
    if (url === KEYS) {
      const keys = await Promise.all(provider.keys.map(async ({ kid, pair }) => ({ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig", alg: "RS256" })));
      return Response.json({ keys });
    }
    if (url === TOKEN && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`) return Response.json({ error: "invalid_client" }, { status: 401 });
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        await provider.exchanging;
        const given = provider.codes.get(form.get("code") ?? "");
        provider.codes.delete(form.get("code") ?? "");
        const verified = given && given.redirectUri === form.get("redirect_uri") && given.challenge === (await challengeOf(form.get("code_verifier") ?? ""));
        return verified ? tokensFor(given.sub, given.sid, given.nonce) : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (form.get("grant_type") === "refresh_token") {
        await provider.refreshing;
        const given = provider.refreshTokens.get(form.get("refresh_token") ?? "");
        provider.refreshTokens.delete(form.get("refresh_token") ?? "");
        return given && !provider.revoked.has(given.sub) ? tokensFor(given.sub, given.sid, null) : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (url === USERINFO) {
      if (provider.userinfoDown) return new Response("Bad gateway", { status: 502 });
      const sub = provider.accessTokens.get(request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "");
      return sub ? Response.json(provider.people.get(sub)) : new Response(null, { status: 401 });
    }
    return new Response("Not found", { status: 404 });
  });
  return provider;
}

let provider: ReturnType<typeof fakeProvider>;

beforeEach(async () => {
  await freshDeploy();
  forgetProviders();
  provider = fakeProvider();
});
afterEach(() => vi.restoreAllMocks());

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** A request for one of sign-in's pages, straight to the Worker, as the static assets' layer only passes them on deployed. */
const page = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith({}, path, init);

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** The provider as the Single sign-on card sets it up. */
const SETUP = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, name: "Acme" };

/** What `PUT /api/account/sso` answers `session` for the card's `changes`. */
const saveSso = (session: Session | null, changes: Record<string, unknown> = {}) =>
  api(SSO_SETTINGS_PATH, { method: "PUT", headers: as(session), body: JSON.stringify({ ...SETUP, ...changes }) });

/** What `PATCH /api/account` answers `session` for `settings`. */
const change = (session: Session, settings: AccountSettings) => api("/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify({ settings }) });

async function turn(administrator: Session, settings: AccountSettings): Promise<void> {
  const response = await change(administrator, settings);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Sets Ember up with the provider, as the card's `changes` say, with single sign-on on, and the only way in if `only` says so. */
async function setUpWithSso({ only = false, ...changes }: { only?: boolean } & Record<string, unknown> = {}): Promise<Session> {
  const administrator = await setUp();
  const saved = await saveSso(administrator, changes);
  expect(saved.status, await saved.clone().text()).toBe(200);
  await turn(administrator, { ssoJoin: true, ...(only ? { ssoSignIn: true } : {}) });
  return administrator;
}

const joinCode = async () => ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;

/** Joins as Grace with the join link, with a password. */
async function joinAsGrace(): Promise<Session> {
  const response = await api(`/api/join/${await joinCode()}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Invites Grace by email as `administrator`, and joins with the invitation's link, which proves her address is hers. */
async function joinWithInvitation(administrator: Session): Promise<Session> {
  const invited = await api("/api/invitations", { method: "POST", headers: as(administrator), body: JSON.stringify({ emailAddresses: [grace.emailAddress] }) });
  expect(invited.status, await invited.clone().text()).toBe(200);
  const [{ link }] = ((await invited.json()) as { outcomes: Array<{ link: string }> }).outcomes as [{ link: string }];
  const token = new URL(link).hash.slice("#token=".length);
  const joined = await api("/api/join/invitation", { method: "POST", body: JSON.stringify({ name: grace.name, password: grace.password, token }) });
  expect(joined.status, await joined.clone().text()).toBe(201);
  return { user: shown(((await joined.json()) as { user: Me }).user), cookie: cookieOf(joined) };
}

/** Where the provider sends the browser back to, with `params`, from a browser with the cookies `cookie`, at `ip`. */
const callback = (params: Record<string, string>, cookie?: string, ip = IP) =>
  page(`${SSO_CALLBACK_PATH}?${new URLSearchParams(params)}`, { headers: { "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}) } });

/** Starts signing in with SSO, and plays the provider's part: the callback's params, and the state's cookie. */
async function startAndAuthorize(returnTo: string | null = null): Promise<{ params: Record<string, string>; cookie: string }> {
  const started = await page(ssoSignInPath(returnTo));
  expect(started.status, await started.clone().text()).toBe(302);
  const location = started.headers.get("Location")!;
  const state = new URL(location).searchParams.get("state")!;
  return { params: { code: provider.authorize(location), state, iss: ISSUER }, cookie: cookieOf(started) };
}

/** Signs in with SSO from a new browser as `person`, from start to the callback's answer. */
async function signInWithSso(person: Person = provider.signingIn, { returnTo = null, ip = IP }: { returnTo?: string | null; ip?: string } = {}): Promise<Response> {
  provider.signingIn = person;
  const { params, cookie } = await startAndAuthorize(returnTo);
  return callback(params, cookie, ip);
}

const locationOf = (response: Response) => response.headers.get("Location");

/** Where the callback sends the browser back to sign in, saying why signing in with SSO didn't work. */
const backToSignIn = (problem: string) => `${origin}/session/new?sso=${problem}`;

/** The session a callback's answer signs the browser in with, as the app sees it. */
async function signedInAs(response: Response): Promise<Me> {
  expect(response.status).toBe(302);
  expect(locationOf(response)).not.toContain("sso=");
  const answer = await api("/api/me", { headers: { Cookie: sessionCookieOf(response) } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { user: Me }).user;
}

/** The session cookie among those an answer sets, rather than the state's it forgets. */
const sessionCookieOf = (response: Response) => response.headers.getSetCookie().find((cookie) => !cookie.includes("sso_state"))!.split(";")[0]!;

/** Signs in with SSO as `person`, answering the session. */
async function ssoSession(person: Person = provider.signingIn): Promise<Session> {
  const response = await signInWithSso(person);
  return { user: shown(await signedInAs(response)), cookie: sessionCookieOf(response) };
}

const signsIn = async (session: Session) => (await api("/api/me", { headers: as(session) })).status === 200;
const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;
const identities = () => workspaceSql("SELECT issuer, subject, user_id FROM identities");
const bootstrap = async () => (await (await api("/api/bootstrap")).json()) as Bootstrap;
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;
const profileOf = async (session: Session) => ((await (await api("/api/users/me/profile", { headers: as(session) })).json()) as ProfileAnswer).profile;
const tokenRequests = () => provider.requests.filter(({ url }) => url === TOKEN);

async function statusOf(viewer: Session, id: UserId): Promise<UserStatus | undefined> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === id)?.status;
}

/** The provider as Ember shows it once the card has set it up. */
const SHOWN: SsoSettings = { source: "saved", issuer: ISSUER, clientId: CLIENT_ID, name: "Acme", scopes: [], groupsClaim: "groups", allowedGroups: [], linksVerifiedEmails: false };

describe("Single sign-on's settings", () => {
  it("set up a provider once its discovery document checks out, sealing its secret, and show it to administrators without it", async () => {
    const administrator = await setUp();
    const saved = await saveSso(administrator);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("Cache-Control")).toBe("no-store");
    expect(await saved.json()).toEqual({ sso: SHOWN } satisfies SsoSaved);
    expect(provider.requests.map(({ url }) => url)).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
    expect(provider.requests[0]!.redirect).toBe("manual");
    const stored = await storedSettings();
    expect(stored.sso).toMatchObject({ issuer: ISSUER, client_id: CLIENT_ID });
    expect(JSON.stringify(stored)).not.toContain(CLIENT_SECRET);
    const settings = (await (await api("/api/account", { headers: as(administrator) })).json()) as { sso: SsoSettings | null };
    expect(settings.sso).toEqual(SHOWN);
  });

  it("refuse an issuer whose discovery document doesn't answer, names another issuer, or doesn't offer PKCE, on the issuer's field", async () => {
    const administrator = await setUp();
    provider.down = true;
    expect(await (await saveSso(administrator)).json()).toEqual({ error: ISSUER_UNREACHABLE, field: "issuer" });
    provider.down = false;
    provider.discovery = { issuer: `${ISSUER}/` };
    expect(await (await saveSso(administrator)).json()).toEqual({ error: ISSUER_MISMATCH, field: "issuer" });
    provider.discovery = { code_challenge_methods_supported: ["plain"] };
    const unsupported = await saveSso(administrator);
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({ error: ISSUER_UNSUPPORTED, field: "issuer" });
    expect((await storedSettings()).sso).toBeUndefined();
  });

  it("keep the secret when it's left out for the same app, but need it for another", async () => {
    const administrator = await setUp();
    expect((await saveSso(administrator)).status).toBe(200);
    const renamed = await saveSso(administrator, { clientSecret: undefined, name: "Acme Corp", allowedGroups: "staff\nengineering" });
    expect(await renamed.json()).toEqual({ sso: { ...SHOWN, name: "Acme Corp", allowedGroups: ["staff", "engineering"] } });
    const another = await saveSso(administrator, { clientId: "another-app", clientSecret: undefined });
    expect(another.status).toBe(422);
    expect(await another.json()).toEqual({ error: CLIENT_SECRET_REFUSED, field: "clientSecret" });
  });

  it("are an administrator's to set up", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    expect((await saveSso(null)).status).toBe(401);
    const refused = await saveSso(member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: SSO_FORBIDDEN });
    expect((await api(SSO_SETTINGS_PATH, { method: "DELETE", headers: as(member) })).status).toBe(403);
    expect(provider.requests).toEqual([]);
    expect((await saveSso(administrator)).status).toBe(200);
  });

  it("turn single sign-on on only once a provider is set up, and forgetting it turns it off", async () => {
    const administrator = await setUp();
    const early = await change(administrator, { ssoJoin: true });
    expect(early.status).toBe(422);
    expect(await early.json()).toEqual({ error: SSO_SETUP_NEEDED });
    expect((await saveSso(administrator)).status).toBe(200);
    await turn(administrator, { ssoSignIn: true });
    expect((await bootstrap()).account).toMatchObject({ ssoJoin: true, ssoSignIn: true });
    const forgotten = await api(SSO_SETTINGS_PATH, { method: "DELETE", headers: as(administrator) });
    expect(await forgotten.json()).toEqual({ sso: null });
    expect((await bootstrap()).account).toMatchObject({ ssoJoin: false, ssoSignIn: false });
    expect((await bootstrap()).signInWithSso).toBeNull();
  });

  it("never have SSO only and Open on together", async () => {
    const administrator = await setUpWithSso();
    await turn(administrator, { openSignUp: true });
    const both = await change(administrator, { ssoSignIn: true });
    expect(both.status).toBe(422);
    expect(await both.json()).toEqual({ error: OPEN_WITH_SSO });
  });
});

describe("Sign in with SSO", () => {
  it("is offered on the sign-in page by the provider's name while it's on", async () => {
    const administrator = await setUp();
    expect((await bootstrap()).signInWithSso).toBeNull();
    expect((await saveSso(administrator)).status).toBe(200);
    expect((await bootstrap()).signInWithSso).toBeNull();
    await turn(administrator, { ssoJoin: true });
    expect((await bootstrap()).signInWithSso).toBe("Acme");
  });

  it("sends the browser to the provider with a new state, nonce and S256 code challenge, which a cookie keeps for 10 minutes", async () => {
    await setUpWithSso({ scopes: "urn:zitadel:iam:org:project:id:zitadel:aud" });
    const started = await page(ssoSignInPath("/rooms/1"));
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("Location")!);
    expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: `${origin}${SSO_CALLBACK_PATH}`,
      scope: "openid profile email offline_access urn:zitadel:iam:org:project:id:zitadel:aud",
      state: expect.stringMatching(/^[\w-]{20,}$/),
      nonce: expect.stringMatching(/^[\w-]{40,}$/),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
    });
    const cookie = started.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/sso_state=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=600/);
    // The verifier stays in the cookie: only its challenge goes to the provider.
    const [state, , , nonce, verifier] = cookie.split(";")[0]!.split("=")[1]!.split(".");
    expect([state, nonce]).toEqual([location.searchParams.get("state"), location.searchParams.get("nonce")]);
    expect(location.searchParams.get("code_challenge")).toBe(await challengeOf(verifier!));
  });

  it("goes back to sign in while single sign-on isn't set up, or is off", async () => {
    const administrator = await setUp();
    expect(locationOf(await page(ssoSignInPath(null)))).toBe(backToSignIn("unavailable"));
    expect((await saveSso(administrator)).status).toBe(200);
    expect(locationOf(await page(ssoSignInPath(null)))).toBe(backToSignIn("off"));
  });

  it("signs in someone new as a member by way of the welcome page, linked to their account at the provider, keeping its refresh token sealed", async () => {
    await setUpWithSso();
    const response = await signInWithSso(katherine, { returnTo: "/rooms" });
    const me = await signedInAs(response);
    expect(me).toMatchObject({ name: "Katherine Johnson", administrator: false });
    expect(locationOf(response)).toBe(`${origin}/welcome?return_to=%2Frooms`);
    // With a username made from their name, as Memberful's members get, and no password.
    expect(await workspaceSql("SELECT username, email_address, password_digest FROM users WHERE id = ?", me.id)).toEqual([
      { username: "katherinejohnson", email_address: katherine.email, password_digest: null },
    ]);
    expect(response.headers.getSetCookie()).toContainEqual(expect.stringMatching(/sso_state=;/));
    expect(await identities()).toEqual([{ issuer: ISSUER, subject: katherine.sub, user_id: me.id }]);
    const [identity] = (await workspaceSql("SELECT refresh_token, refresh_due_at, email_address FROM identities")) as Array<{ refresh_token: string; refresh_due_at: number; email_address: string }>;
    expect(identity!.email_address).toBe(katherine.email);
    expect(identity!.refresh_token).toEqual(expect.any(String));
    expect(identity!.refresh_token).not.toMatch(/^rt-/);
    expect(identity!.refresh_due_at).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(await workspaceSql("SELECT identity_issuer, identity_sid FROM sessions WHERE identity_issuer IS NOT NULL")).toEqual([{ identity_issuer: ISSUER, identity_sid: "provider-session-1" }]);
    // The code went with the app's secret, the redirect URI and the verifier, never following a redirect.
    const [exchange] = tokenRequests();
    expect(exchange!.redirect).toBe("manual");
    expect(Object.fromEntries(new URLSearchParams(exchange!.body))).toEqual({
      grant_type: "authorization_code",
      code: expect.any(String),
      code_verifier: expect.stringMatching(/^[\w-]{43}$/),
      redirect_uri: `${origin}${SSO_CALLBACK_PATH}`,
    });
  });

  it("signs the same person in again by their account there, whatever its name and email address are now", async () => {
    await setUpWithSso();
    const first = await signedInAs(await signInWithSso(katherine));
    const response = await signInWithSso({ ...katherine, name: "Katherine G. Johnson", email: "kj@example.com" }, { returnTo: "/rooms" });
    expect((await signedInAs(response)).id).toBe(first.id);
    // Straight to the page they signed in from: the welcome page is for someone new.
    expect(locationOf(response)).toBe(`${origin}/rooms`);
    expect(await count("identities")).toBe(1);
  });

  it("starts the DM welcoming someone new, as joining with the join link does", async () => {
    const administrator = await setUpWithSso();
    const me = await signedInAs(await signInWithSso(katherine));
    const { rooms } = (await (await api("/api/sidebar", { headers: as(administrator) })).json()) as Sidebar;
    expect(rooms.find((room) => room.kind === "direct")).toMatchObject({ joined: { userId: me.id }, members: expect.arrayContaining([{ id: me.id, name: "Katherine Johnson" }]) });
  });

  it("passes over a name with a word Blocked words keeps out, going by the next one the provider gives", async () => {
    const administrator = await setUpWithSso();
    const blocked = await api("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ blockedWords: ["johnson"] }) });
    expect(blocked.status, await blocked.clone().text()).toBe(200);
    const me = await signedInAs(await signInWithSso(katherine));
    expect(me.name).toBe("katherine");
    expect(await workspaceSql("SELECT username FROM users WHERE id = ?", me.id)).toEqual([{ username: "katherine" }]);
  });

  it.each([
    ["for another app", { aud: "another-app" }],
    ["from another issuer", { iss: "https://evil.example.com" }],
    ["with another nonce", { nonce: "another-nonce" }],
    ["that has expired", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["issued in the future", { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ["for several apps without naming this one", { aud: [CLIENT_ID, "another-app"] }],
  ])("signs nobody in with an ID token %s", async (_, claims) => {
    await setUpWithSso();
    provider.idToken = claims;
    expect(locationOf(await signInWithSso(katherine))).toBe(backToSignIn("failed"));
    expect(await count("identities")).toBe(0);
  });

  it("signs nobody in with an ID token signed with a key the provider never published, or with none", async () => {
    await setUpWithSso();
    provider.signWith = forgedKey;
    expect(locationOf(await signInWithSso(katherine))).toBe(backToSignIn("failed"));
    // An unsigned token, as `alg: none` makes, is never taken, whatever it says.
    const unsigned = (nonce: string) => `${encoded({ alg: "none", typ: "JWT" })}.${encoded({ ...katherine, iss: ISSUER, aud: CLIENT_ID, iat: now(), exp: now() + 3600, nonce })}.`;
    provider.signWith = firstKey;
    const { params, cookie } = await startAndAuthorize();
    provider.givenIdToken = unsigned(provider.codes.get(params.code!)!.nonce);
    expect(locationOf(await callback(params, cookie))).toBe(backToSignIn("failed"));
    expect(await count("identities")).toBe(0);
  });

  it("reads the provider's keys again for a key it hasn't seen, as once it rotates them", async () => {
    await setUpWithSso();
    await signedInAs(await signInWithSso(katherine));
    provider.keys = [nextKey];
    provider.signWith = nextKey;
    // Keys are read again for an unknown one at most once a minute.
    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    await signedInAs(await signInWithSso(dorothy));
    expect(provider.requests.filter(({ url }) => url === KEYS)).toHaveLength(2);
  });

  it("signs nobody in with a state this browser didn't start with, a code given before, or another issuer's", async () => {
    await setUpWithSso();
    const { params, cookie } = await startAndAuthorize();
    expect(locationOf(await callback({ ...params, state: "another-state" }, cookie))).toBe(backToSignIn("failed"));
    expect(locationOf(await callback(params))).toBe(backToSignIn("failed"));
    expect(locationOf(await callback({ ...params, iss: "https://evil.example.com" }, cookie))).toBe(backToSignIn("failed"));
    expect(locationOf(await callback({ state: params.state!, iss: ISSUER, error: "access_denied" }, cookie))).toBe(backToSignIn("failed"));
    // The provider's word is needed while it says it gives it (RFC 9207).
    expect(locationOf(await callback({ code: params.code!, state: params.state! }, cookie))).toBe(backToSignIn("failed"));
    expect(tokenRequests()).toHaveLength(0);
    await signedInAs(await callback(params, cookie));
    expect(locationOf(await callback(params, cookie))).toBe(backToSignIn("failed"));
    expect(await count("identities")).toBe(1);
  });

  it("lets in only the people in a group the card lets in", async () => {
    await setUpWithSso({ allowedGroups: "staff" });
    expect(locationOf(await signInWithSso(dorothy))).toBe(backToSignIn("membership"));
    expect(await count("identities")).toBe(0);
    await signedInAs(await signInWithSso(katherine));
  });

  it("signs nobody in by groups the card no longer goes by, once they change while the provider answers", async () => {
    const administrator = await setUpWithSso();
    let answer!: () => void;
    provider.exchanging = new Promise((resolve) => (answer = resolve));
    provider.signingIn = dorothy;
    const { params, cookie } = await startAndAuthorize();
    const signingIn = callback(params, cookie);
    await vi.waitFor(() => expect(tokenRequests()).toHaveLength(1));
    expect((await saveSso(administrator, { allowedGroups: "staff" })).status).toBe(200);
    answer();
    expect(locationOf(await signingIn)).toBe(backToSignIn("failed"));
    expect(await count("identities")).toBe(0);
    // Signing in again goes by the card as it is.
    expect(locationOf(await signInWithSso(dorothy))).toBe(backToSignIn("membership"));
  });

  it("signs nobody in by an app the card no longer goes by, once its Client ID changes while the provider answers", async () => {
    const administrator = await setUpWithSso();
    let answer!: () => void;
    provider.exchanging = new Promise((resolve) => (answer = resolve));
    const { params, cookie } = await startAndAuthorize();
    const signingIn = callback(params, cookie);
    await vi.waitFor(() => expect(tokenRequests()).toHaveLength(1));
    // Another app at the same provider, which the ID token on its way isn't for.
    expect((await saveSso(administrator, { clientId: "another-app", clientSecret: "another-app-secret" })).status).toBe(200);
    answer();
    expect(locationOf(await signingIn)).toBe(backToSignIn("failed"));
    expect(await count("identities")).toBe(0);
  });

  it("reads groups from a claim the card names, as an object of Zitadel's roles", async () => {
    const roles = "urn:zitadel:iam:org:project:roles";
    await setUpWithSso({ allowedGroups: "staff", groupsClaim: roles });
    await signedInAs(await signInWithSso({ ...dorothy, groups: undefined, [roles]: { staff: { "1234": "acme.example.com" } } }));
    expect(locationOf(await signInWithSso({ ...katherine, groups: undefined, [roles]: { visitors: {} } }))).toBe(backToSignIn("membership"));
  });

  it("goes by the ID token alone while the userinfo endpoint is down, unless the groups the card needs could come from it alone", async () => {
    const administrator = await setUpWithSso();
    provider.userinfoDown = true;
    provider.idToken = { groups: undefined };
    await signedInAs(await signInWithSso(katherine));
    expect((await saveSso(administrator, { allowedGroups: "staff" })).status).toBe(200);
    expect(locationOf(await signInWithSso(katherine))).toBe(backToSignIn("failed"));
    provider.idToken = {};
    await signedInAs(await signInWithSso(katherine));
  });

  it("sends someone whose email address someone here has to sign in with their password, unless the card links verified ones", async () => {
    const administrator = await setUpWithSso();
    const member = await joinWithInvitation(administrator);
    expect(locationOf(await signInWithSso(gracesAccount))).toBe(backToSignIn("taken"));
    expect(await count("identities")).toBe(0);
    expect((await saveSso(administrator, { linksVerifiedEmails: true })).status).toBe(200);
    expect(locationOf(await signInWithSso({ ...gracesAccount, email_verified: false }))).toBe(backToSignIn("taken"));
    expect((await signedInAs(await signInWithSso(gracesAccount))).id).toBe(member.user.id);
    expect(await identities()).toEqual([{ issuer: ISSUER, subject: gracesAccount.sub, user_id: member.user.id }]);
  });

  it("goes by whether the address the userinfo endpoint gives was verified, not another the ID token verified", async () => {
    const administrator = await setUpWithSso({ linksVerifiedEmails: true });
    await joinWithInvitation(administrator);
    provider.idToken = { email: "someone@example.com", email_verified: true };
    const { email_verified: _, ...unverified } = gracesAccount;
    expect(locationOf(await signInWithSso(unverified))).toBe(backToSignIn("taken"));
    expect(await count("identities")).toBe(0);
  });

  it("never links by email address an account the card's groups don't let in, leaving whoever has it be", async () => {
    const administrator = await setUpWithSso({ linksVerifiedEmails: true, allowedGroups: "staff" });
    const member = await joinWithInvitation(administrator);
    await workspaceSql("UPDATE users SET invited_by = NULL");
    expect(locationOf(await signInWithSso({ ...gracesAccount, groups: ["visitors"] }))).toBe(backToSignIn("membership"));
    expect(await count("identities")).toBe(0);
    expect(await signsIn(member)).toBe(true);
    expect(await statusOf(administrator, member.user.id)).toBe("active");
  });

  it("gives someone new no email address the provider didn't verify, keeping it with their account there", async () => {
    await setUpWithSso();
    const me = await signedInAs(await signInWithSso({ ...dorothy, email_verified: false }));
    expect(await workspaceSql("SELECT email_address FROM users WHERE id = ?", me.id)).toEqual([{ email_address: null }]);
    expect(await workspaceSql("SELECT email_address FROM identities")).toEqual([{ email_address: dorothy.email }]);
  });

  it("links by a verified email address only someone who proved it's theirs here, by joining with a link emailed to it", async () => {
    const administrator = await setUpWithSso({ linksVerifiedEmails: true });
    // Anyone with the join link can type a colleague's address before the colleague joins.
    await joinAsGrace();
    expect(locationOf(await signInWithSso(gracesAccount))).toBe(backToSignIn("taken"));
    expect(await count("identities")).toBe(0);
  });

  it("forgets that someone proved their address once they change it, even back", async () => {
    const administrator = await setUpWithSso({ linksVerifiedEmails: true });
    const member = await joinWithInvitation(administrator);
    for (const emailAddress of ["grace@navy.example.com", grace.emailAddress]) {
      const changed = await api("/api/users/me/profile", { method: "PATCH", headers: as(member), body: JSON.stringify({ name: grace.name, emailAddress, bio: "", currentPassword: grace.password }) });
      expect(changed.status, await changed.clone().text()).toBe(200);
    }
    expect(locationOf(await signInWithSso(gracesAccount))).toBe(backToSignIn("taken"));
  });

  it("never links an administrator by email address, who connects one from their profile", async () => {
    const administrator = await setUpWithSso({ linksVerifiedEmails: true });
    const member = await joinWithInvitation(administrator);
    const promoted = await api(`/api/account/users/${member.user.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ role: "administrator" }) });
    expect(promoted.status).toBe(200);
    expect(locationOf(await signInWithSso(gracesAccount))).toBe(backToSignIn("taken"));
    expect(await count("identities")).toBe(0);
  });

  it("signs nobody new in once it's off, but still those who joined with it", async () => {
    const administrator = await setUpWithSso();
    const katherines = await signedInAs(await signInWithSso(katherine));
    await turn(administrator, { ssoJoin: false });
    expect((await bootstrap()).signInWithSso).toBe("Acme");
    expect((await signedInAs(await signInWithSso(katherine))).id).toBe(katherines.id);
    expect(locationOf(await signInWithSso(dorothy))).toBe(backToSignIn("off"));
  });
});

describe("SSO only", () => {
  it("turns signing in with just a name off", async () => {
    await setUpWithSso({ only: true });
    expect((await bootstrap()).guestSignIn).toBe(false);
    const guest = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Mallory" }) });
    expect(guest.status).toBe(403);
    expect(await guest.json()).toEqual({ error: SSO_SIGN_IN_NEEDED });
  });

  it("sends a member whose password checks out on to the provider, which brings them back connected and signed in", async () => {
    const administrator = await setUpWithSso();
    const member = await joinAsGrace();
    await turn(administrator, { ssoSignIn: true });
    const password = await api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": IP }, body: JSON.stringify({ emailAddress: grace.emailAddress, password: grace.password }) });
    expect(password.status).toBe(202);
    const { ssoConnection } = (await password.json()) as SsoConnection;
    provider.signingIn = gracesAccount;
    const location = new URL(ssoConnection);
    const back = await callback({ code: provider.authorize(ssoConnection), state: location.searchParams.get("state")!, iss: ISSUER }, cookieOf(password));
    expect((await signedInAs(back)).id).toBe(member.user.id);
    expect(await identities()).toEqual([{ issuer: ISSUER, subject: gracesAccount.sub, user_id: member.user.id }]);
    // An administrator still signs in with a password.
    expect((await api("/api/session", { method: "POST", body: JSON.stringify({ emailAddress: ada.emailAddress, password: ada.password }) })).status).toBe(201);
  });

  it("lets you connect your account from your profile, and disconnect it, with your password", async () => {
    const administrator = await setUpWithSso();
    const member = await joinAsGrace();
    await turn(administrator, { ssoSignIn: true });
    expect((await profileOf(member)).sso).toEqual({ name: "Acme", ssoOnly: true, connected: null });
    const unchecked = await api(SSO_CONNECTIONS_PATH, { method: "POST", headers: as(member), body: JSON.stringify({}) });
    expect(unchecked.status).toBe(422);
    const started = await api(SSO_CONNECTIONS_PATH, { method: "POST", headers: as(member), body: JSON.stringify({ currentPassword: grace.password }) });
    expect(started.status).toBe(202);
    const { ssoConnection } = (await started.json()) as SsoConnection;
    provider.signingIn = gracesAccount;
    const back = await callback({ code: provider.authorize(ssoConnection), state: new URL(ssoConnection).searchParams.get("state")!, iss: ISSUER }, `${cookieOf(started)}; ${member.cookie}`);
    expect(locationOf(back)).toBe(`${origin}/users/me/profile?sso=connected`);
    expect((await profileOf(member)).sso).toEqual({ name: "Acme", ssoOnly: true, connected: { name: gracesAccount.name, emailAddress: grace.emailAddress } });

    const disconnected = await api(SSO_CONNECTIONS_PATH, { method: "DELETE", headers: as(member), body: JSON.stringify({ currentPassword: grace.password }) });
    expect(disconnected.status).toBe(200);
    expect(((await disconnected.json()) as ProfileAnswer).profile.sso).toEqual({ name: "Acme", ssoOnly: true, connected: null });
    expect(await count("identities")).toBe(0);
  });

  it("keeps the latest refresh token once a second connection, started alongside, finds the account connected", async () => {
    const administrator = await setUpWithSso();
    const member = await joinAsGrace();
    await turn(administrator, { ssoSignIn: true });
    const start = () => api(SSO_CONNECTIONS_PATH, { method: "POST", headers: as(member), body: JSON.stringify({ currentPassword: grace.password }) });
    const [first, second] = [await start(), await start()];
    provider.signingIn = gracesAccount;
    const finish = async (started: Response) => {
      const { ssoConnection } = (await started.json()) as SsoConnection;
      const state = new URL(ssoConnection).searchParams.get("state")!;
      return locationOf(await callback({ code: provider.authorize(ssoConnection), state, iss: ISSUER }, `${cookieOf(started)}; ${member.cookie}`));
    };
    expect(await finish(first)).toBe(`${origin}/users/me/profile?sso=connected`);
    expect(await finish(second)).toBe(`${origin}/users/me/profile?sso=connected`);
    const latest = [...provider.refreshTokens.keys()].at(-1);
    await workspaceSql("UPDATE identities SET refresh_due_at = ?", Date.now() - 1);
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    const refreshes = tokenRequests().map(({ body }) => new URLSearchParams(body)).filter((form) => form.get("grant_type") === "refresh_token");
    expect(refreshes.map((form) => form.get("refresh_token"))).toEqual([latest]);
  });
});

describe("A first password", () => {
  const saveProfile = (session: Session, changes: unknown) => api("/api/users/me/profile", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

  it("is refused to someone without one whom single sign-on signs in, as it does while the provider is set up, whether or not it's on", async () => {
    const administrator = await setUpWithSso();
    const session = await ssoSession(katherine);
    const elsewhere = await ssoSession(katherine);
    for (const on of [true, false]) {
      await turn(administrator, { ssoJoin: on });
      for (const changes of [{ password: "a long enough password" }, { password: "a long enough password", emailAddress: "katherine@nasa.example" }]) {
        const refused = await saveProfile(session, changes);
        expect(refused.status).toBe(422);
        expect(await refused.json()).toEqual({ error: PASSWORD_WITH_SSO });
      }
    }
    // Nothing was saved, and their other sessions go on, as a new password would end them.
    expect(await profileOf(session)).toMatchObject({ password: false, emailAddress: katherine.email });
    expect(await signsIn(elsewhere)).toBe(true);
    expect(await identities()).toEqual([{ issuer: ISSUER, subject: katherine.sub, user_id: session.user.id }]);
    // The rest of their profile is theirs to change as before, their email address included.
    expect((await saveProfile(session, { emailAddress: "katherine@nasa.example" })).status).toBe(200);
    // Disconnect says it's how they sign in, since there's no password for them to set first.
    const disconnected = await api(SSO_CONNECTIONS_PATH, { method: "DELETE", headers: as(session), body: JSON.stringify({ currentPassword: "a long enough password" }) });
    expect(disconnected.status).toBe(422);
    expect(await disconnected.json()).toEqual({ error: SSO_DISCONNECT_WITHOUT_PASSWORD });
  });

  it("is theirs to set once no provider signs them in, which keeps their account there connected", async () => {
    const administrator = await setUpWithSso();
    const session = await ssoSession(katherine);
    expect((await api(SSO_SETTINGS_PATH, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    const saved = await saveProfile(session, { password: "a long enough password" });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as ProfileAnswer).profile).toMatchObject({ password: true, sso: null });
    expect(await identities()).toEqual([{ issuer: ISSUER, subject: katherine.sub, user_id: session.user.id }]);
  });
});

describe("Members only and SSO only together", () => {
  const MEMBERFUL_SITE = "https://example.memberful.com";
  const MEMBERFUL_KEYS = { MEMBERFUL_URL: `${MEMBERFUL_SITE}/`, MEMBERFUL_CLIENT_ID: "ember-client-id", MEMBERFUL_CLIENT_SECRET: "ember-client-secret" };
  /** A member of the Memberful site, as its member API describes them. */
  const mary = { id: "5151", email: "mary@example.com", fullName: "Mary Jackson", unrestrictedAccess: false, subscriptions: [{ active: true }] };

  /** A request to a Worker that has Memberful's keys too. */
  const withMemberful = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith(MEMBERFUL_KEYS, path, init);

  beforeEach(() => {
    // The Memberful site answers beside the provider: a token for any code, and Mary to it.
    const fetch = vi.mocked(globalThis.fetch);
    const providers = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      const url = new Request(input, init).url;
      if (url === `${MEMBERFUL_SITE}/oauth/token`) return Response.json({ access_token: "memberful-token", token_type: "bearer", expires_in: 900, refresh_token: "r" });
      if (url.startsWith(`${MEMBERFUL_SITE}/api/graphql/member`)) return Response.json({ data: { currentMember: mary } });
      return providers(input, init);
    });
  });

  async function turnOn(administrator: Session, settings: AccountSettings): Promise<void> {
    const response = await withMemberful("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ settings }) });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** Starts signing in with Memberful: the state, and the cookie that keeps it. */
  async function startMemberful(): Promise<{ state: string; cookie: string }> {
    const started = await withMemberful(memberfulSignInPath(null));
    expect(started.status, await started.clone().text()).toBe(302);
    return { state: new URL(started.headers.get("Location")!).searchParams.get("state")!, cookie: cookieOf(started) };
  }

  const memberfulCallback = ({ state, cookie }: { state: string; cookie: string }) =>
    withMemberful(`${MEMBERFUL_CALLBACK_PATH}?${new URLSearchParams({ code: "a-code", state })}`, { headers: { "CF-Connecting-IP": IP, Cookie: cookie } });

  const offered = async () => (await (await withMemberful("/api/bootstrap")).json()) as Bootstrap;

  /** Signs in with Memberful as Mary, answering the session. */
  async function marysSession(): Promise<Session> {
    const response = await memberfulCallback(await startMemberful());
    expect(response.status).toBe(302);
    const cookie = response.headers.getSetCookie().find((cookie) => !cookie.includes("memberful_state"))!.split(";")[0]!;
    const me = await api("/api/me", { headers: { Cookie: cookie } });
    return { user: shown(((await me.json()) as { user: Me }).user), cookie };
  }

  /** Starts connecting the account `session` signs in to one at `path`'s way in, from their profile, without a password. */
  const connect = (path: string, session: Session) =>
    withMemberful(path, { method: "POST", headers: { ...as(session), "CF-Connecting-IP": IP }, body: JSON.stringify({}) });

  it("keeps no Memberful site for the accounts the provider links, so Set up Memberful takes keys for one", async () => {
    const administrator = await setUpWithSso();
    await ssoSession(katherine);
    // Memberful takes the keys: its admin API answers the API key, and its token endpoint the app, refusing only the code.
    const fetch = vi.mocked(globalThis.fetch);
    const answers = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      const url = new Request(input, init).url;
      if (url === `${MEMBERFUL_SITE}/api/graphql`) return Response.json({ data: { members: { totalCount: 0 } } });
      if (url === `${MEMBERFUL_SITE}/oauth/token`) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return answers(input, init);
    });
    const keys = { site: MEMBERFUL_SITE, apiKey: "an-api-key", clientId: "an-oauth-identifier", clientSecret: "an-oauth-secret", webhookSecret: "a-webhook-secret" };
    const saved = await api("/api/account/memberful_keys", { method: "PUT", headers: as(administrator), body: JSON.stringify(keys) });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ memberfulSite: MEMBERFUL_SITE, memberfulSiteKept: null });
  });

  it("can both be on, when someone new joins with either, and the join link and guests are off", async () => {
    const administrator = await setUpWithSso({ only: true });
    await turnOn(administrator, { memberfulSignIn: true });
    expect((await offered()).account).toMatchObject({ memberfulJoin: true, memberfulSignIn: true, ssoJoin: true, ssoSignIn: true });
    expect(await offered()).toMatchObject({ signInWithMemberful: true, signInWithSso: "Acme" });

    expect((await signedInAs(await signInWithSso(katherine))).name).toBe("Katherine Johnson");
    const marys = await memberfulCallback(await startMemberful());
    expect(marys.status).toBe(302);
    expect(locationOf(marys)).not.toContain("memberful=");
    expect(await count("identities")).toBe(2);

    const joined = await api(`/api/join/${await joinCode()}`, { method: "POST", body: JSON.stringify(grace) });
    expect(joined.status).toBe(403);
    expect(await joined.json()).toMatchObject({ error: MEMBERFUL_OR_SSO_SIGN_IN_NEEDED });
    const guest = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Mallory" }) });
    expect(await guest.json()).toEqual({ error: MEMBERFUL_OR_SSO_SIGN_IN_NEEDED });
  });

  it("sends a member whose password checks out on to connect their account at either", async () => {
    const administrator = await setUpWithSso();
    await joinAsGrace();
    await turnOn(administrator, { ssoSignIn: true, memberfulSignIn: true });
    const password = await withMemberful("/api/session", { method: "POST", headers: { "CF-Connecting-IP": IP }, body: JSON.stringify({ emailAddress: grace.emailAddress, password: grace.password }) });
    expect(password.status).toBe(202);
    const connection = (await password.json()) as MemberfulConnection & SsoConnection;
    expect(new URL(connection.memberfulConnection).origin).toBe(MEMBERFUL_SITE);
    expect(new URL(connection.ssoConnection).origin).toBe(ISSUER);
    expect(password.headers.getSetCookie().map((cookie) => cookie.split("=")[0])).toEqual(["__Host-memberful_state", "__Host-sso_state"]);
  });

  it("connects neither to someone without a password whom the other signs in, since holding their session is all there'd be to check", async () => {
    const administrator = await setUpWithSso({ only: true });
    await turnOn(administrator, { memberfulSignIn: true });
    const katherines = await ssoSession(katherine);
    const marys = await marysSession();

    const memberful = await connect(MEMBERFUL_CONNECTIONS_PATH, katherines);
    expect(memberful.status).toBe(403);
    expect(await memberful.json()).toEqual({ error: MEMBERFUL_WITH_SSO });
    const sso = await connect(SSO_CONNECTIONS_PATH, marys);
    expect(sso.status).toBe(403);
    expect(await sso.json()).toEqual({ error: SSO_WITH_MEMBERFUL });
    expect(sso.headers.getSetCookie()).toEqual([]);
    expect(await count("identities")).toBe(2);
  });

  it("lets nobody in with Memberful while SSO only is on and Memberful isn't members only, as its card shows it off", async () => {
    const administrator = await setUpWithSso();
    await turnOn(administrator, { memberfulJoin: true });
    const early = await startMemberful();
    await turnOn(administrator, { ssoSignIn: true });
    expect((await offered()).signInWithMemberful).toBe(false);
    expect(locationOf(await withMemberful(memberfulSignInPath(null)))).toBe(`${origin}/session/new?memberful=off`);
    // Nor a sign-in started before.
    expect(locationOf(await memberfulCallback(early))).toBe(`${origin}/session/new?memberful=off`);
    expect(await count("identities")).toBe(0);
  });

  it("keeps someone linked to both in while either lets them in, suspending them once neither does", async () => {
    await withWorkspaceEnv({ ...MEMBERFUL_KEYS, MEMBERFUL_API_KEY: "ember-api-key" }, async () => {
      const administrator = await setUpWithSso({ only: true, allowedGroups: "staff" });
      await turnOn(administrator, { memberfulSignIn: true });
      const session = await ssoSession(katherine);
      const now = new Date().toISOString();
      await workspaceSql(
        "INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at, lapsed) VALUES (?, ?, ?, ?, ?, ?, 0)",
        MEMBERFUL_SITE,
        mary.id,
        session.user.id,
        Date.now(),
        now,
        now,
      );
      provider.people.set(katherine.sub, { ...katherine, groups: ["visitors"] });
      await workspaceSql("UPDATE identities SET refresh_due_at = ? WHERE issuer = ?", Date.now() - 1, ISSUER);
      expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
      expect(await statusOf(administrator, session.user.id)).toBe("active");
      // Once Memberful's word is that hers has lapsed too, nothing lets her in.
      await workspaceSql("UPDATE identities SET lapsed = 1 WHERE issuer = ?", MEMBERFUL_SITE);
      await workspaceSql("UPDATE identities SET refresh_due_at = ? WHERE issuer = ?", Date.now() - 1, ISSUER);
      expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
      expect(await statusOf(administrator, session.user.id)).toBe("suspended");
    });
  });

  it("goes by a Memberful membership nobody asks Memberful about anymore no longer, as without its admin API key", async () => {
    await withWorkspaceEnv(MEMBERFUL_KEYS, async () => {
      const administrator = await setUpWithSso({ only: true, allowedGroups: "staff" });
      await turnOn(administrator, { memberfulSignIn: true });
      const session = await ssoSession(katherine);
      const now = new Date().toISOString();
      await workspaceSql(
        "INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at, lapsed) VALUES (?, ?, ?, ?, ?, ?, 0)",
        MEMBERFUL_SITE,
        mary.id,
        session.user.id,
        Date.now(),
        now,
        now,
      );
      provider.people.set(katherine.sub, { ...katherine, groups: ["visitors"] });
      await workspaceSql("UPDATE identities SET refresh_due_at = ? WHERE issuer = ?", Date.now() - 1, ISSUER);
      expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
      expect(await statusOf(administrator, session.user.id)).toBe("suspended");
    });
  });

  it("goes by an account at the provider no longer once it keeps no refresh token to ask with", async () => {
    await withWorkspaceEnv({ ...MEMBERFUL_KEYS, MEMBERFUL_API_KEY: "ember-api-key" }, async () => {
      const administrator = await setUpWithSso({ only: true });
      await turnOn(administrator, { memberfulSignIn: true });
      const session = await ssoSession(katherine);
      await workspaceSql("UPDATE identities SET refresh_token = NULL, refresh_due_at = NULL");
      const now = new Date().toISOString();
      await workspaceSql(
        "INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        MEMBERFUL_SITE,
        mary.id,
        session.user.id,
        0,
        now,
        now,
      );
      // Memberful's word that her membership has lapsed, as its admin API gives it, with nothing to keep her in.
      await runInDurableObject(workspaceStub(), (workspace: Workspace) =>
        (workspace as unknown as { applyMemberships(issuer: string, via: string, memberships: Map<string, boolean>, readAt: number): Promise<void> }).applyMemberships(
          MEMBERFUL_SITE,
          "memberful",
          new Map([[mary.id, false]]),
          Date.now(),
        ),
      );
      expect(await statusOf(administrator, session.user.id)).toBe("suspended");
    });
  });

  it("leaves the sessions Memberful signed in be once the provider no longer takes a refresh token, as Memberful still lets its person in", async () => {
    await withWorkspaceEnv(MEMBERFUL_KEYS, async () => {
      const administrator = await setUpWithSso({ only: true });
      await turnOn(administrator, { memberfulSignIn: true });
      const signedIn = await ssoSession(katherine);
      const now = new Date().toISOString();
      await workspaceSql(
        "INSERT INTO identities (issuer, subject, user_id, checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        MEMBERFUL_SITE,
        mary.id,
        signedIn.user.id,
        Date.now(),
        now,
        now,
      );
      const marys = await memberfulCallback(await startMemberful());
      const viaMemberful = { user: signedIn.user, cookie: marys.headers.getSetCookie().find((cookie) => cookie.includes("session_token"))!.split(";")[0]! };
      expect(await signsIn(viaMemberful)).toBe(true);
      provider.revoked.add(katherine.sub);
      await workspaceSql("UPDATE identities SET refresh_due_at = ? WHERE issuer = ?", Date.now() - 1, ISSUER);
      expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
      expect(await signsIn(signedIn)).toBe(false);
      expect(await signsIn(viaMemberful)).toBe(true);
    });
  });

  it("signs nobody in with SSO, not even someone linked, while Memberful is members only and SSO only isn't on", async () => {
    const administrator = await setUpWithSso();
    await signedInAs(await signInWithSso(katherine));
    const early = await startAndAuthorize();
    await turnOn(administrator, { memberfulSignIn: true });
    expect((await offered()).signInWithSso).toBeNull();
    expect(locationOf(await page(ssoSignInPath(null)))).toBe(backToSignIn("off"));
    // Nor a sign-in started before.
    expect(locationOf(await callback(early.params, early.cookie))).toBe(backToSignIn("off"));
  });
});

describe("Back-channel logout", () => {
  /** A logout token for `claims`, as the provider signs it. */
  const logoutToken = (claims: Record<string, unknown>, key = firstKey, header: Record<string, unknown> = { typ: "logout+jwt" }) =>
    signed(key, { iss: ISSUER, aud: CLIENT_ID, iat: now(), jti: random(), events: { [BACKCHANNEL_LOGOUT]: {} }, ...claims }, header);

  const logOut = async (token: string) =>
    api(SSO_LOGOUT_PATH, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "cross-site" }, body: new URLSearchParams({ logout_token: token }).toString() });

  it("ends the sessions the provider's session signed in, once its token checks out", async () => {
    await setUpWithSso();
    const first = await ssoSession(katherine);
    provider.sid = "provider-session-2";
    const second = await ssoSession(katherine);
    const answer = await logOut(await logoutToken({ sid: "provider-session-1" }));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("Cache-Control")).toBe("no-store");
    expect(await signsIn(first)).toBe(false);
    expect(await signsIn(second)).toBe(true);
  });

  it("ends every session an account signed in, by its subject, but nobody else's", async () => {
    const administrator = await setUpWithSso();
    const first = await ssoSession(katherine);
    provider.sid = "provider-session-2";
    const second = await ssoSession(katherine);
    const others = await ssoSession(dorothy);
    expect((await logOut(await logoutToken({ sub: katherine.sub }))).status).toBe(200);
    expect([await signsIn(first), await signsIn(second), await signsIn(others), await signsIn(administrator)]).toEqual([false, false, true, true]);
    // Signing out there isn't a suspension: she signs in again.
    await signedInAs(await signInWithSso(katherine));
  });

  it.each([
    ["without the logout event", { events: {} }],
    ["with a nonce", { nonce: "a-nonce" }],
    ["for another app", { aud: "another-app" }],
    ["from another issuer", { iss: "https://evil.example.com" }],
    ["issued long ago", { iat: Math.floor(Date.now() / 1000) - 3600 }],
    ["naming nobody", { sub: undefined, sid: undefined }],
  ])("refuses a token %s", async (_, claims) => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    const answer = await logOut(await logoutToken({ sub: katherine.sub, ...claims }));
    expect(answer.status).toBe(400);
    expect(await signsIn(session)).toBe(true);
  });

  it("refuses a token signed with a key the provider never published, or of another type", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    expect((await logOut(await logoutToken({ sub: katherine.sub }, forgedKey))).status).toBe(400);
    expect((await logOut(await logoutToken({ sub: katherine.sub }, firstKey, { typ: "id+jwt" }))).status).toBe(400);
    expect(await signsIn(session)).toBe(true);
  });

  it("takes a token typed JWT, as the spec allows, or written with application/", async () => {
    await setUpWithSso();
    const first = await ssoSession(katherine);
    expect((await logOut(await logoutToken({ sub: katherine.sub }, firstKey, { typ: "JWT" }))).status).toBe(200);
    expect(await signsIn(first)).toBe(false);
    const second = await ssoSession(katherine);
    expect((await logOut(await logoutToken({ sub: katherine.sub }, firstKey, { typ: "application/logout+jwt" }))).status).toBe(200);
    expect(await signsIn(second)).toBe(false);
  });

  it("never ends a session signed in after the token was issued, as one delivered late, or again, would", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    const replayed = await logoutToken({ sub: katherine.sub, iat: now() - 5 * 60 });
    expect((await logOut(replayed)).status).toBe(200);
    expect(await signsIn(session)).toBe(true);
  });

  it("never ends a session signed in a minute after the token was issued, though that's within the skew it's taken with, but ends one from before", async () => {
    await setUpWithSso();
    const before = await ssoSession(katherine);
    // Signed in two minutes ago, signed out there a minute ago, and signed in again since.
    await workspaceSql("UPDATE sessions SET created_at = ? WHERE identity_sid = ?", new Date(Date.now() - 2 * 60 * 1000).toISOString(), "provider-session-1");
    provider.sid = "provider-session-2";
    const again = await ssoSession(katherine);
    expect((await logOut(await logoutToken({ sub: katherine.sub, iat: now() - 60 }))).status).toBe(200);
    expect([await signsIn(before), await signsIn(again)]).toEqual([false, true]);
  });

  it("answers 404 while there's no provider", async () => {
    await setUp();
    expect((await logOut(await logoutToken({ sub: katherine.sub }))).status).toBe(404);
  });
});

describe("Checking accounts with their refresh tokens", () => {
  const refreshed = () => workspaceSql("SELECT refresh_token, refresh_due_at FROM identities") as Promise<Array<{ refresh_token: string | null; refresh_due_at: number | null }>>;
  const due = () => workspaceSql("UPDATE identities SET refresh_due_at = ?", Date.now() - 1);

  it("asks the provider again every hour, keeping the refresh token it gives in its place", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    const [before] = await refreshed();
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    const [after] = await refreshed();
    expect(after!.refresh_token).not.toBe(before!.refresh_token);
    expect(after!.refresh_due_at).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(new URLSearchParams(tokenRequests().at(-1)!.body).get("grant_type")).toBe("refresh_token");
    expect(await signsIn(session)).toBe(true);
  });

  it("signs out an account whose refresh token the provider no longer takes, without suspending it", async () => {
    const administrator = await setUpWithSso();
    const session = await ssoSession(katherine);
    provider.revoked.add(katherine.sub);
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(false);
    expect(await refreshed()).toEqual([{ refresh_token: null, refresh_due_at: null }]);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
  });

  /**
   * Holds up the Workspace's changes (`oneAtATime`) until `release` is called, counting those that line up
   * behind it in `lined`. It's let go from inside the Workspace, which alone can settle what it made.
   */
  async function holdChanges(): Promise<{ release: () => Promise<void>; lined: MockInstance }> {
    let letGo!: () => void;
    let lined!: MockInstance;
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const line = workspace as unknown as { oneAtATime(change: () => Promise<void>): Promise<void> };
      void line.oneAtATime(() => new Promise((resolve) => (letGo = resolve)));
      lined = vi.spyOn(line, "oneAtATime");
    });
    return { release: () => runInDurableObject(workspaceStub(), () => letGo()), lined };
  }

  it("leaves an account's sessions be once a sign-in keeps a token of its own while the provider is asked with the one before", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    provider.revoked.add(katherine.sub);
    await due();
    const { release, lined } = await holdChanges();
    const signingIn = signInWithSso(katherine);
    let checking: Promise<boolean>;
    try {
      await vi.waitFor(() => expect(lined).toHaveBeenCalledTimes(1));
      // The refresh is answered while the sign-in waits to keep its token, and goes by it after.
      checking = runDurableObjectAlarm(workspaceStub());
      await vi.waitFor(() => expect(lined).toHaveBeenCalledTimes(2));
    } finally {
      await release();
    }
    const signedIn = await signingIn;
    expect(await checking).toBe(true);
    expect(await signsIn({ user: session.user, cookie: sessionCookieOf(signedIn) })).toBe(true);
    expect(await signsIn(session)).toBe(true);
    expect((await refreshed())[0]!.refresh_token).not.toBeNull();
  });

  it("ends a session signed in while the provider is asked with a token it no longer takes, once its sign-in kept none of its own", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    provider.revoked.add(katherine.sub);
    provider.signInWithoutRefreshToken = true;
    await due();
    const { release, lined } = await holdChanges();
    const signingIn = signInWithSso(katherine);
    let checking: Promise<boolean>;
    try {
      await vi.waitFor(() => expect(lined).toHaveBeenCalledTimes(1));
      // The refresh is answered while the sign-in waits, which leaves the token asked with in place, and
      // nothing else to ask the provider about its session with.
      checking = runDurableObjectAlarm(workspaceStub());
      await vi.waitFor(() => expect(lined).toHaveBeenCalledTimes(2));
    } finally {
      await release();
    }
    const signedIn = await signingIn;
    expect(await checking).toBe(true);
    expect(await signsIn({ user: session.user, cookie: sessionCookieOf(signedIn) })).toBe(false);
    expect(await signsIn(session)).toBe(false);
    expect(await refreshed()).toEqual([{ refresh_token: null, refresh_due_at: null }]);
  });

  /** Joins as Grace with a password, as `join` has her, then connects her account at the provider from her profile while SSO only is on, answering her password session. */
  async function connectedGrace(administrator: Session, join: (administrator: Session) => Promise<Session> = joinAsGrace): Promise<Session> {
    const member = await join(administrator);
    await turn(administrator, { ssoSignIn: true });
    const started = await api(SSO_CONNECTIONS_PATH, { method: "POST", headers: as(member), body: JSON.stringify({ currentPassword: grace.password }) });
    const { ssoConnection } = (await started.json()) as SsoConnection;
    provider.signingIn = gracesAccount;
    await callback({ code: provider.authorize(ssoConnection), state: new URL(ssoConnection).searchParams.get("state")!, iss: ISSUER }, `${cookieOf(started)}; ${member.cookie}`);
    expect(await signsIn(member)).toBe(true);
    return member;
  }

  it("ends a member's password sessions too while SSO only is on, as the provider no longer takes their refresh token", async () => {
    const administrator = await setUpWithSso();
    const member = await connectedGrace(administrator);
    provider.revoked.add(gracesAccount.sub);
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(member)).toBe(false);
    expect(await statusOf(administrator, member.user.id)).toBe("active");
    expect(await signsIn(administrator)).toBe(true);
  });

  it("ends the sessions an invited person's account signed in while SSO only is on, leaving their password ones, which are a way in of their own", async () => {
    const administrator = await setUpWithSso();
    const invited = await connectedGrace(administrator, joinWithInvitation);
    const signedIn = await ssoSession(gracesAccount);
    provider.revoked.add(gracesAccount.sub);
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(signedIn)).toBe(false);
    expect(await signsIn(invited)).toBe(true);
  });

  it("leaves a member's password sessions be while SSO only is off, when their password is a way in of its own", async () => {
    const administrator = await setUpWithSso();
    const member = await connectedGrace(administrator);
    await turn(administrator, { ssoSignIn: false });
    provider.revoked.add(gracesAccount.sub);
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(member)).toBe(true);
  });

  it("counts a refresh whose userinfo endpoint doesn't answer as no answer, suspending nobody for groups it may give alone", async () => {
    const administrator = await setUpWithSso({ allowedGroups: "staff" });
    const session = await ssoSession(katherine);
    provider.userinfoDown = true;
    // The ID token alone says no groups, as a provider that gives them only at its userinfo endpoint's does.
    provider.idToken = { groups: undefined };
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(true);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
    const [{ refresh_failing_since: since }] = (await workspaceSql("SELECT refresh_failing_since FROM identities")) as [{ refresh_failing_since: number | null }];
    expect(since).not.toBeNull();
  });

  it("keeps an account whose provider has neither a refreshed ID token nor a userinfo endpoint, once it takes the refresh token", async () => {
    forgetProviders();
    provider.discovery = { userinfo_endpoint: undefined };
    await setUpWithSso();
    const session = await ssoSession(katherine);
    provider.refreshWithoutIdToken = true;
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(true);
    const [row] = (await workspaceSql("SELECT refresh_due_at, refresh_failing_since FROM identities")) as Array<{ refresh_due_at: number; refresh_failing_since: number | null }>;
    expect(row).toEqual({ refresh_due_at: expect.any(Number), refresh_failing_since: null });
    expect(row!.refresh_due_at).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
  });

  it("suspends someone who is no longer in a group the card lets in, ending their sessions", async () => {
    const administrator = await setUpWithSso({ allowedGroups: "staff" });
    const session = await ssoSession(katherine);
    provider.people.set(katherine.sub, { ...katherine, groups: ["alumni"] });
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(false);
    expect(await statusOf(administrator, session.user.id)).toBe("suspended");
    expect(locationOf(await signInWithSso({ ...katherine, groups: ["alumni"] }))).toBe(backToSignIn("membership"));
    // Back in the group, she's let back as she signs in.
    await signedInAs(await signInWithSso(katherine));
    expect(await statusOf(administrator, session.user.id)).toBe("active");
  });

  it("puts someone in no group once a refreshed ID token leaves the groups claim out", async () => {
    const administrator = await setUpWithSso({ allowedGroups: "staff" });
    const session = await ssoSession(katherine);
    provider.people.set(katherine.sub, { ...katherine, groups: undefined });
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(false);
    expect(await statusOf(administrator, session.user.id)).toBe("suspended");
  });

  it("suspends nobody by a refresh that answers once the provider it asked has been forgotten", async () => {
    const administrator = await setUpWithSso({ allowedGroups: "staff" });
    const session = await ssoSession(katherine);
    provider.people.set(katherine.sub, { ...katherine, groups: ["visitors"] });
    let answer!: () => void;
    provider.refreshing = new Promise((resolve) => (answer = resolve));
    await due();
    const checking = runDurableObjectAlarm(workspaceStub());
    await vi.waitFor(() => expect(tokenRequests().some(({ body }) => new URLSearchParams(body).get("grant_type") === "refresh_token")).toBe(true));
    expect((await api(SSO_SETTINGS_PATH, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    answer();
    expect(await checking).toBe(true);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
  });

  it("asks again soon, suspending nobody, when the card starts asking about groups while a refresh it didn't need the userinfo endpoint for answers", async () => {
    const administrator = await setUpWithSso();
    const session = await ssoSession(katherine);
    // An ID token without the groups, which the userinfo endpoint alone would give, were it up.
    provider.idToken = { groups: undefined };
    provider.userinfoDown = true;
    let answer!: () => void;
    provider.refreshing = new Promise((resolve) => (answer = resolve));
    await due();
    const checking = runDurableObjectAlarm(workspaceStub());
    await vi.waitFor(() => expect(tokenRequests().some(({ body }) => new URLSearchParams(body).get("grant_type") === "refresh_token")).toBe(true));
    expect((await saveSso(administrator, { allowedGroups: "staff" })).status).toBe(200);
    answer();
    expect(await checking).toBe(true);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
    const [{ refresh_due_at: dueAt }] = (await workspaceSql("SELECT refresh_due_at FROM identities")) as [{ refresh_due_at: number }];
    expect(dueAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
    // Asked again by the card as it is, with the userinfo endpoint up, she's in a group it lets in.
    provider.userinfoDown = false;
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
    expect(await signsIn(session)).toBe(true);
  });

  it("goes by no group a refresh says once the card's Client ID changes while the provider answers, as another app's word", async () => {
    const administrator = await setUpWithSso({ allowedGroups: "staff" });
    const session = await ssoSession(katherine);
    // Out of every group the card lets in, by the word of the app it's about to stop going by.
    provider.people.set(katherine.sub, { ...katherine, groups: ["visitors"] });
    let answer!: () => void;
    provider.refreshing = new Promise((resolve) => (answer = resolve));
    await due();
    const checking = runDurableObjectAlarm(workspaceStub());
    await vi.waitFor(() => expect(tokenRequests().some(({ body }) => new URLSearchParams(body).get("grant_type") === "refresh_token")).toBe(true));
    expect((await saveSso(administrator, { clientId: "another-app", clientSecret: "another-app-secret", allowedGroups: "staff" })).status).toBe(200);
    answer();
    expect(await checking).toBe(true);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
  });

  it("goes by groups only when a refresh without an ID token says them, since the userinfo endpoint may leave them out", async () => {
    const administrator = await setUpWithSso({ allowedGroups: "staff" });
    const session = await ssoSession(katherine);
    provider.refreshWithoutIdToken = true;
    provider.people.set(katherine.sub, { ...katherine, groups: undefined });
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(true);
    provider.people.set(katherine.sub, { ...katherine, groups: ["visitors"] });
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await statusOf(administrator, session.user.id)).toBe("suspended");
  });

  it("stops asking a provider that hasn't answered for a day, ending the account's sessions without suspending anyone", async () => {
    const administrator = await setUpWithSso();
    const session = await ssoSession(katherine);
    provider.down = true;
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(true);
    const [{ refresh_failing_since: since }] = (await workspaceSql("SELECT refresh_failing_since FROM identities")) as [{ refresh_failing_since: number }];
    expect(since).toBeGreaterThan(Date.now() - 60_000);
    await workspaceSql("UPDATE identities SET refresh_failing_since = ?, refresh_due_at = ?", Date.now() - SSO_GIVE_UP_MS - 1, Date.now() - 1);
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await signsIn(session)).toBe(false);
    expect(await refreshed()).toEqual([{ refresh_token: null, refresh_due_at: null }]);
    expect(await statusOf(administrator, session.user.id)).toBe("active");
  });

  it("counts an answer whose ID token doesn't check out as no answer, and forgets the failures once one does", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    provider.signWith = forgedKey;
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    const failing = async () => ((await workspaceSql("SELECT refresh_failing_since FROM identities")) as [{ refresh_failing_since: number | null }])[0].refresh_failing_since;
    expect(await failing()).not.toBeNull();
    expect(await signsIn(session)).toBe(true);
    provider.signWith = firstKey;
    await due();
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    expect(await failing()).toBeNull();
  });

  it("keeps the refresh tokens, asking later, while the provider's secret no longer opens", async () => {
    await setUpWithSso({ only: true });
    await ssoSession(katherine);
    const [before] = await refreshed();
    await due();
    const settings = await storedSettings();
    const sso = settings.sso as Record<string, unknown>;
    await workspaceSql("UPDATE accounts SET settings = ?", JSON.stringify({ ...settings, sso: { ...sso, client_secret: "not-a-sealed-secret" } }));
    await evictDurableObject(workspaceStub());
    // As if it weren't set up: SSO only never keeps people out.
    expect((await bootstrap()).account).toMatchObject({ ssoJoin: false, ssoSignIn: false });
    // The Workspace, started afresh, may run its alarm for the overdue token itself.
    await runDurableObjectAlarm(workspaceStub());
    await vi.waitFor(async () => expect((await refreshed())[0]!.refresh_due_at).toBeGreaterThan(Date.now() + 59 * 60 * 1000));
    expect((await refreshed())[0]!.refresh_token).toBe(before!.refresh_token);
  });

  it("asks again in a few minutes while the provider doesn't answer", async () => {
    await setUpWithSso();
    const session = await ssoSession(katherine);
    const [before] = await refreshed();
    await due();
    provider.down = true;
    // A discovery document read within the hour is kept, so the token endpoint is what doesn't answer.
    expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
    const [after] = await refreshed();
    expect(after!.refresh_token).toBe(before!.refresh_token);
    expect(after!.refresh_due_at).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    expect(after!.refresh_due_at).toBeLessThan(Date.now() + 6 * 60 * 1000);
    expect(await signsIn(session)).toBe(true);
  });
});

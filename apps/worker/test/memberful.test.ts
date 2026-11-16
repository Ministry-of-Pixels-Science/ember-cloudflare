import {
  CloseCode,
  CURRENT_PASSWORD_WRONG,
  MEMBERFUL_CALLBACK_PATH,
  MEMBERFUL_CONNECTIONS_PATH,
  MEMBERFUL_DISCONNECT_PASSWORD_NEEDED,
  MEMBERFUL_DISCONNECT_WITHOUT_EMAIL,
  MEMBERFUL_DISCONNECT_WITHOUT_PASSWORD,
  MEMBERFUL_NOT_CONNECTED,
  MEMBERFUL_PASSWORD_NEEDED,
  MEMBERFUL_SIGN_IN_NEEDED,
  MEMBERFUL_SIGN_IN_PROBLEMS,
  MEMBERFUL_WEBHOOK_PATH,
  memberfulSignInPath,
  PASSWORD_WITH_MEMBERFUL,
  SIGN_IN_LIMITED,
  SIGN_IN_REJECTED,
  type Account,
  type AccountSettings,
  type Bootstrap,
  type Directory,
  type Me,
  type MemberfulConnection,
  type MemberfulConnectionStart,
  type MemberfulDisconnection,
  type NewWorkspace,
  type Profile,
  type ProfileAnswer,
  type RoomSettings,
  type Sidebar,
  type UserId,
  type UserStatus,
  type WorkspaceSettings,
} from "@ember/protocol";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor, newSessionToken } from "../src/auth";
import { toHex } from "../src/encoding";
import type { Env } from "../src/env";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import {
  api,
  apiWith,
  builtPages,
  cookieOf,
  createRoom,
  freshDeploy,
  openWorkspaceSocket,
  origin,
  pushBrowser,
  shown,
  signIn,
  withWorkspaceEnv,
  workspaceSql,
  workspaceStub,
  type Session,
} from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

/** The Memberful site whose members sign in, and its custom app's keys, as the deployment's secrets give them. */
const SITE = "https://example.memberful.com";
const KEYS = { MEMBERFUL_URL: `${SITE}/`, MEMBERFUL_CLIENT_ID: "ember-client-id", MEMBERFUL_CLIENT_SECRET: "ember-client-secret" };
/** The custom app's API key, which the admin API takes, and the secret Memberful signs the site's webhooks with. */
const API_KEY = "ember-api-key";
const WEBHOOK_SECRET = "ember-webhook-secret";
/** Every key of a deployment that hears Memberful's webhooks: the sign-in keys, the API key and the webhook's secret. */
const ALL_KEYS = { ...KEYS, MEMBERFUL_API_KEY: API_KEY, MEMBERFUL_WEBHOOK_SECRET: WEBHOOK_SECRET };
/** The code Memberful sends the browser back with, and the access token it's exchanged for. */
const CODE = "a-code-from-memberful";
const ACCESS_TOKEN = "an-access-token";
/** Where Memberful sign-ins come from, unless a test says otherwise. */
const IP = "203.0.113.20";

/** A member of the Memberful site as its member API describes them. */
interface MemberfulMember {
  id: string;
  email: string | null;
  fullName: string | null;
  unrestrictedAccess: boolean;
  subscriptions: Array<{ active: boolean }>;
}

/** Katherine, a member of the Memberful site with an active subscription, and no account here yet. */
const katherine: MemberfulMember = {
  id: "4242",
  email: "katherine@example.com",
  fullName: "Katherine Johnson",
  unrestrictedAccess: false,
  subscriptions: [{ active: true }],
};

/** Dorothy, another member of the Memberful site with an active subscription. */
const dorothy: MemberfulMember = { ...katherine, id: "4243", email: "dorothy@example.com", fullName: "Dorothy Vaughan" };

/** A request the fake Memberful site was sent. */
interface SentToMemberful {
  method: string;
  url: string;
  redirect: string;
  authorization: string | null;
  body: string;
}

/**
 * Stands in for the Memberful site: its token endpoint gives an access token for `CODE` sent with the
 * app's keys, and its member API describes `site.member`, which a test can change, to that token, once
 * `site.signInHeld` settles. Its admin API describes `site.member` and `site.others` by their ids to the
 * app's API key, as they were when it was asked, once `site.held` settles, or answers 502 if `site.down`
 * was set then. Either fails to describe the members whose ids are in `site.failing`, answering as GraphQL
 * answers a field that failed: null, with an error saying where. What it's sent goes in `site.requests`.
 */
function fakeMemberful(member: Partial<MemberfulMember> | null = {}) {
  const site = {
    member: member && { ...katherine, ...member },
    others: [] as MemberfulMember[],
    held: Promise.resolve(),
    signInHeld: Promise.resolve(),
    down: false,
    failing: [] as string[],
    requests: [] as SentToMemberful[],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    // Read as bytes, which workerd doesn't warn of for a form, as it does reading one as text.
    const body = new TextDecoder().decode(await request.arrayBuffer());
    site.requests.push({ method: request.method, url: request.url, redirect: request.redirect, authorization: request.headers.get("Authorization"), body });
    const url = new URL(request.url);
    if (request.method === "POST" && url.href === `${SITE}/oauth/token`) {
      const form = new URLSearchParams(body);
      const valid =
        form.get("grant_type") === "authorization_code" &&
        form.get("code") === CODE &&
        form.get("client_id") === KEYS.MEMBERFUL_CLIENT_ID &&
        form.get("client_secret") === KEYS.MEMBERFUL_CLIENT_SECRET;
      if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: ACCESS_TOKEN, token_type: "bearer", expires_in: 900, refresh_token: "a-refresh-token" });
    }
    if (url.origin === SITE && url.pathname === "/api/graphql/member" && request.headers.get("Authorization") === `Bearer ${ACCESS_TOKEN}`) {
      await site.signInHeld;
      if (site.member && site.failing.includes(site.member.id)) {
        const error = { message: "Internal server error", path: ["currentMember", "subscriptions"] };
        return Response.json({ data: { currentMember: { ...site.member, subscriptions: null } }, errors: [error] });
      }
      return Response.json({ data: { currentMember: site.member } });
    }
    if (request.method === "POST" && url.href === `${SITE}/api/graphql`) {
      // As Memberful answers a wrong key: 200, with errors and no data.
      if (request.headers.get("Authorization") !== `Bearer ${API_KEY}`) return Response.json({ errors: [{ message: "Invalid authentication token." }] });
      // What it says is as things were when it was asked, however long it takes to answer.
      const [down, failing] = [site.down, site.failing];
      const asked = [...(JSON.parse(body) as { query: string }).query.matchAll(/(m\d+): member\(id: ("(?:[^"\\]|\\.)*")\)/g)].map(([, alias, id]) => ({
        alias: alias!,
        id: JSON.parse(id!) as string,
      }));
      const described = (id: string) => [site.member, ...site.others].find((member) => member?.id === id) ?? null;
      const membershipOf = (member: MemberfulMember | null) => member && { unrestrictedAccess: member.unrestrictedAccess, subscriptions: member.subscriptions };
      const data = Object.fromEntries(asked.map(({ alias, id }) => [alias, failing.includes(id) ? null : membershipOf(described(id))]));
      const errors = asked.filter(({ id }) => failing.includes(id)).map(({ alias }) => ({ message: "Internal server error", path: [alias] }));
      await site.held;
      if (down) return new Response("Bad gateway", { status: 502 });
      return Response.json(errors.length > 0 ? { data, errors } : { data });
    }
    return new Response("Unauthorized", { status: 401 });
  });
  return site;
}

/** The members whose memberships each request to the fake site's admin API asked after, by their ids. */
const askedAfter = (requests: SentToMemberful[]) =>
  requests
    .filter(({ url }) => url === `${SITE}/api/graphql`)
    .map(({ body }) => [...(JSON.parse(body) as { query: string }).query.matchAll(/member\(id: ("[^"]*")\)/g)].map(([, id]) => JSON.parse(id!) as string));

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** A request to a Worker that has the Memberful keys, answered as the Worker answers it, without following a redirect. `path` may be a whole URL. */
const withKeys = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith(KEYS, path, init);

/** The same, to a Worker without them, as this suite's is. */
const withoutKeys = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith({}, path, init);

/** What `PATCH /api/account` answers `session` for `body`, on a deployment with the Memberful keys unless `keys` is false. */
const change = (session: Session | null, body: unknown, { keys = true } = {}) =>
  apiWith(keys ? KEYS : {}, "/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify(body) });

/** Turns Memberful on, members only unless `membersOnly` is false, or off, which turns Members only off too, as `administrator`. */
async function turnMemberful(administrator: Session, on: boolean, { membersOnly = true } = {}): Promise<void> {
  const settings: AccountSettings = on ? { memberfulJoin: true, memberfulSignIn: membersOnly } : { memberfulJoin: false };
  const response = await change(administrator, { settings });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Sets Ember up with Memberful on, members only unless `membersOnly` is false, with Ada as its administrator. */
async function setUpWithMemberful({ membersOnly = true } = {}): Promise<Session> {
  const administrator = await setUp();
  await turnMemberful(administrator, true, { membersOnly });
  return administrator;
}

const joinCode = async () => ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;

/** Joins as Grace with the join link, with a password, as people did before Memberful was members only. */
async function joinAsGrace(): Promise<Session> {
  const response = await api(`/api/join/${await joinCode()}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** A sign-in with an email address and password, from `ip`. */
const signInWithPassword = (body: unknown, ip = IP) => api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify(body) });

/** Starts signing in with Memberful, coming back to `returnTo` once signed in, if given. */
const start = (returnTo: string | null = null, host = origin) => withKeys(`${host}${memberfulSignInPath(returnTo)}`);

/** The state a start sent the browser to Memberful with, and the cookie it keeps it in. */
function startedWith(started: Response): { state: string; cookie: string } {
  expect(started.status).toBe(302);
  return { state: new URL(started.headers.get("Location")!).searchParams.get("state")!, cookie: cookieOf(started) };
}

/** Where Memberful sends the browser back to, with `params`, from a browser with the cookie `cookie`, at `ip`. */
const callback = (params: Record<string, string>, cookie?: string, ip = IP) =>
  withKeys(`${MEMBERFUL_CALLBACK_PATH}?${new URLSearchParams(params)}`, {
    headers: { "CF-Connecting-IP": ip, "User-Agent": "Katherine's laptop", ...(cookie ? { Cookie: cookie } : {}) },
  });

/** Signs in with Memberful from a new browser, from start to the callback's answer, coming back to `returnTo` if given. */
async function signInWithMemberful({ returnTo = null, ip = IP }: { returnTo?: string | null; ip?: string } = {}): Promise<Response> {
  const { state, cookie } = startedWith(await start(returnTo));
  return callback({ code: CODE, state }, cookie, ip);
}

/** Where an answer sends the browser. */
const locationOf = (response: Response) => response.headers.get("Location");

/** Where the callback sends the browser back to sign in, saying why signing in with Memberful didn't work. */
const backToSignIn = (problem: string) => `${origin}/session/new?memberful=${problem}`;

/** The session a callback's answer signs the browser in with, as the app sees it. */
async function signedInAs(response: Response): Promise<Me> {
  expect(response.status).toBe(302);
  const answer = await api("/api/me", { headers: { Cookie: cookieOf(response) } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { user: Me }).user;
}

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

const identities = () => workspaceSql("SELECT issuer, subject, user_id FROM identities");

const bootstrap = async () => (await (await api("/api/bootstrap")).json()) as Bootstrap;

/** Whether the sign-in page offers Sign in with Memberful, on a deployment with the Memberful keys unless `keys` says otherwise. */
const offersMemberful = async (keys: Partial<Env> = KEYS) => ((await (await apiWith(keys, "/api/bootstrap")).json()) as Bootstrap).signInWithMemberful;

/** The account's settings as they're stored. */
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as unknown;

/** The workspace as pages show a new one, with Memberful's settings off but as `memberful` says. */
const account = (memberful: Partial<Pick<Account, "memberfulJoin" | "memberfulSignIn">> = {}): Account => ({
  name: "Ember",
  tagline: "",
  hideTranslationButtons: true,
  customStyles: "",
  restrictRoomCreation: false,
  logo: null,
  customDomain: null,
  joinLink: true,
  openSignUp: false,
  memberfulJoin: false,
  memberfulSignIn: false,
  emailDomainSignUp: false,
  emailDomains: [],
  navigationIcons: {},
  huddles: false,
  huddleCameras: true,
  huddleScreens: true,
  ...memberful,
});

/** Memberful on and members only, as an account has them. */
const MEMBERS_ONLY = { memberfulJoin: true, memberfulSignIn: true };

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Sign in with Memberful", () => {
  describe("the settings", () => {
    it("let an administrator turn Memberful on once the deployment has the keys, then make it members only, telling every tab", async () => {
      const administrator = await setUp();
      const socket = await openWorkspaceSocket(administrator);
      const on = await change(administrator, { settings: { memberfulJoin: true } });
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ account: account({ memberfulJoin: true }) });
      expect(await socket.next()).toEqual({ type: "account.updated", account: account({ memberfulJoin: true }) });
      expect(await storedSettings()).toMatchObject({ memberful_join: true, memberful_sign_in: false });
      expect((await bootstrap()).account).toEqual(account({ memberfulJoin: true }));

      const membersOnly = await change(administrator, { settings: { memberfulSignIn: true } });
      expect(await membersOnly.json()).toEqual({ account: account(MEMBERS_ONLY) });
      expect(await socket.next()).toEqual({ type: "account.updated", account: account(MEMBERS_ONLY) });
      expect(await storedSettings()).toMatchObject({ memberful_join: true, memberful_sign_in: true });

      expect((await change(administrator, { settings: { memberfulSignIn: false } })).status).toBe(200);
      expect((await bootstrap()).account).toEqual(account({ memberfulJoin: true }));
      await turnMemberful(administrator, false);
      expect((await bootstrap()).account).toEqual(account());
      socket.ws.close(1000);
    });

    it("turn Memberful on with Members only, and Members only off with Memberful, which it's never on without", async () => {
      const administrator = await setUp();
      const changed = async (settings: AccountSettings) => ((await (await change(administrator, { settings })).json()) as { account: Account }).account;
      expect(await changed({ memberfulSignIn: true })).toEqual(account(MEMBERS_ONLY));
      expect(await changed({ memberfulJoin: false })).toEqual(account());
      expect(await storedSettings()).toMatchObject({ memberful_join: false, memberful_sign_in: false });
      expect(await changed({ memberfulJoin: false, memberfulSignIn: true })).toEqual(account());
      expect(await changed({ memberfulJoin: true, memberfulSignIn: true })).toEqual(account(MEMBERS_ONLY));
    });

    it.each([
      ["Members only, as Memberful's only setting was", '{"memberful_sign_in":true}', MEMBERS_ONLY],
      ["Members only off", '{"memberful_sign_in":false}', {}],
      ["Members only without Memberful", '{"memberful_join":false,"memberful_sign_in":true}', {}],
      ["Memberful without Members only", '{"memberful_join":true}', { memberfulJoin: true }],
    ])("read %s", async (_, stored, memberful) => {
      await setUp();
      await workspaceSql("UPDATE accounts SET settings = ?", stored);
      // Started afresh, the Workspace has to read the account again.
      await evictDurableObject(workspaceStub());
      expect((await bootstrap()).account).toEqual(account(memberful));
    });

    it("save both together, so that turning Members only off leaves Memberful on in a workspace from before it had a switch", async () => {
      const administrator = await setUp();
      await workspaceSql("UPDATE accounts SET settings = ?", '{"memberful_sign_in":true}');
      await evictDurableObject(workspaceStub());
      expect((await change(administrator, { settings: { memberfulSignIn: false } })).status).toBe(200);
      expect(await storedSettings()).toEqual({ memberful_join: true, memberful_sign_in: false });
      await evictDurableObject(workspaceStub());
      expect((await bootstrap()).account).toEqual(account({ memberfulJoin: true }));
    });

    it("names the Memberful site to administrators' settings once the deployment has all three keys, its address's origin", async () => {
      const administrator = await setUp();
      const settings = async (changes = {}) =>
        ((await (await apiWith(changes, "/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings).memberfulSite;
      expect(await settings(KEYS)).toBe(SITE);
      expect(await settings({ ...KEYS, MEMBERFUL_URL: `${SITE}/members?ref=1` })).toBe(SITE);
      expect(await settings()).toBeNull();
      expect(await settings({ ...KEYS, MEMBERFUL_CLIENT_SECRET: " " })).toBeNull();
      // A site Ember would send the client secret to in the clear, or that isn't an address at all, is none.
      expect(await settings({ ...KEYS, MEMBERFUL_URL: "http://example.memberful.com" })).toBeNull();
      expect(await settings({ ...KEYS, MEMBERFUL_URL: "example.memberful.com" })).toBeNull();
      // But one on this computer, where the browser tests fake one, is a site.
      expect(await settings({ ...KEYS, MEMBERFUL_URL: "http://127.0.0.1:8790/" })).toBe("http://127.0.0.1:8790");
      expect(await settings({ ...KEYS, MEMBERFUL_URL: "http://localhost:8790" })).toBe("http://localhost:8790");
    });

    it("can't be turned on until the deployment has the keys, but can be turned off without them", async () => {
      const administrator = await setUp();
      for (const settings of [{ memberfulJoin: true }, { memberfulSignIn: true }]) {
        const refused = await change(administrator, { settings }, { keys: false });
        expect(refused.status).toBe(422);
        expect(await refused.json()).toEqual({ error: "Set up Memberful first, which gives Ember your Memberful site's keys." });
      }
      expect((await bootstrap()).account).toEqual(account());

      await turnMemberful(administrator, true);
      expect((await change(administrator, { settings: { memberfulSignIn: false } }, { keys: false })).status).toBe(200);
      expect((await change(administrator, { settings: { memberfulJoin: false } }, { keys: false })).status).toBe(200);
      expect((await bootstrap()).account).toEqual(account());
    });

    it("are an administrator's to change", async () => {
      await setUp();
      const member = await joinAsGrace();
      for (const settings of [{ memberfulJoin: true }, { memberfulSignIn: true }]) {
        expect((await change(member, { settings })).status).toBe(403);
        expect((await change(null, { settings })).status).toBe(401);
      }
      expect((await bootstrap()).account).toEqual(account());
    });
  });

  describe("while it's members only", () => {
    it("turns the join link off: its page sends people to sign in, and its form is refused before it's read", async () => {
      await setUpWithMemberful();
      const code = await joinCode();
      const page = await apiWith({ ASSETS: builtPages }, `/join/${code}`);
      expect(page.status).toBe(302);
      expect(locationOf(page)).toBe(`${origin}/session/new`);
      // A code that isn't the join code is still nothing.
      expect((await apiWith({ ASSETS: builtPages }, "/join/not-the-code")).status).toBe(404);

      const joined = await api(`/api/join/${code}`, { method: "POST", body: JSON.stringify(grace) });
      expect(joined.status).toBe(403);
      expect(await joined.json()).toEqual({ error: MEMBERFUL_SIGN_IN_NEEDED, redirect: "/session/new" });
      expect(joined.headers.get("Set-Cookie")).toBeNull();
      expect(await count("users")).toBe(1);
    });

    it("turns signing in with just a name off", async () => {
      await setUpWithMemberful();
      expect((await bootstrap()).guestSignIn).toBe(false);
      const response = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Guest" }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: MEMBERFUL_SIGN_IN_NEEDED });
      expect(await count("users")).toBe(1);
    });

    it("doesn't add someone with just a name while it's being turned on", async () => {
      const administrator = await setUp();
      const [adas, guests] = await Promise.all(
        [administrator.cookie.split("=")[1]!, newSessionToken()].map((token) => credentialsFor(token, new Request(origin), env as unknown as Env)),
      );
      const signedIn = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
        const store = (workspace as unknown as { store: WorkspaceStore }).store;
        const changeAccount = store.changeAccount.bind(store);
        let reach!: () => void;
        const reached = new Promise<void>((resolve) => (reach = resolve));
        let save!: () => void;
        const saving = new Promise<void>((resolve) => (save = resolve));
        // On D1 a sign-in can read the workspace as it was before Members only is saved, and add a guest after.
        vi.spyOn(store, "changeAccount").mockImplementationOnce(async (...args) => {
          reach();
          await saving;
          return changeAccount(...args);
        });

        const turningOn = workspace.changeAccount(adas!, { settings: { memberfulSignIn: true } }, "ember.test");
        await reached;
        const signingIn = workspace.signInGuest("Guest", guests!.tokenDigest, guests!.client);
        save();
        expect(await turningOn).toMatchObject({ memberfulSignIn: true });
        return signingIn;
      });
      expect(signedIn).toBe("memberful");
      expect(await count("users")).toBe(1);
    });

    it("signs only administrators in with a password, and tells a member so only once their password checks out", async () => {
      const administrator = await setUp();
      await joinAsGrace();
      await turnMemberful(administrator, true);

      expect((await signInWithPassword({ emailAddress: ada.emailAddress, password: ada.password })).status).toBe(201);
      const member = await signInWithPassword({ emailAddress: grace.emailAddress, password: grace.password });
      expect(member.status).toBe(403);
      expect(await member.json()).toEqual({ error: MEMBERFUL_SIGN_IN_NEEDED });
      expect(member.headers.get("Set-Cookie")).toBeNull();
      // A wrong password says nothing of whether there's an account.
      const wrong = await signInWithPassword({ emailAddress: grace.emailAddress, password: "wrong" });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: SIGN_IN_REJECTED });
    });

    it("doesn't sign in an administrator made a member while their sign-in was checked", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const promoted = await api(`/api/account/users/${member.user.id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ role: "administrator" }) });
      expect(promoted.status).toBe(200);
      await turnMemberful(administrator, true);
      // As if she had a password, which the sign-in checked.
      await workspaceSql("UPDATE users SET password_digest = ? WHERE id = ?", "checked", member.user.id);
      const [adas, laptop] = await Promise.all(
        [administrator.cookie.split("=")[1]!, newSessionToken()].map((token) => credentialsFor(token, new Request(origin), env as unknown as Env)),
      );
      const [signedIn, signedInNow] = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
        const store = (workspace as unknown as { store: WorkspaceStore }).store;
        const signsInWhileMembersOnly = store.signsInWhileMembersOnly.bind(store);
        let read!: () => void;
        const reading = new Promise<void>((resolve) => (read = resolve));
        let answer!: () => void;
        const answering = new Promise<void>((resolve) => (answer = resolve));
        // On D1 a sign-in can read Grace as an administrator, and start her session only once she's a member.
        vi.spyOn(store, "signsInWhileMembersOnly").mockImplementationOnce(async (userId) => {
          const did = await signsInWhileMembersOnly(userId);
          read();
          await answering;
          return did;
        });

        const signingIn = workspace.startSession(member.user.id, "checked", null, laptop!.tokenDigest, laptop!.client);
        await reading;
        expect(await workspace.changeRole(adas!, member.user.id, "member")).toMatchObject({ role: "member" });
        answer();
        return [await signingIn, await workspace.me(laptop!)];
      });
      expect(signedIn).toBeNull();
      expect(signedInNow).toBeNull();
    });

    it("leaves the sessions people have signed in", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      await turnMemberful(administrator, true);
      expect((await api("/api/me", { headers: as(member) })).status).toBe(200);
    });
  });

  describe("beside the other ways", () => {
    it("leaves the join link, signing in with just a name, and everyone's password as they were", async () => {
      const administrator = await setUp();
      await joinAsGrace();
      await turnMemberful(administrator, true, { membersOnly: false });
      expect((await apiWith({ ASSETS: builtPages }, `/join/${await joinCode()}`)).status).toBe(200);
      const dorothys = { name: "Dorothy Vaughan", emailAddress: "dorothy@example.com", password: "a long enough password" };
      expect((await api(`/api/join/${await joinCode()}`, { method: "POST", body: JSON.stringify(dorothys) })).status).toBe(201);
      expect((await bootstrap()).guestSignIn).toBe(true);
      expect((await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Guest" }) })).status).toBe(201);
      expect((await signInWithPassword({ emailAddress: grace.emailAddress, password: grace.password })).status).toBe(201);
    });

    it("lets the Memberful site's members join, and sign in again, with their Memberful account", async () => {
      await setUpWithMemberful({ membersOnly: false });
      fakeMemberful();
      const user = await signedInAs(await signInWithMemberful());
      expect(user).toEqual({ id: expect.any(String), name: "Katherine Johnson", administrator: false });
      expect(await identities()).toEqual([{ issuer: SITE, subject: "4242", user_id: user.id }]);
      expect(await signedInAs(await signInWithMemberful())).toEqual(user);
    });

    it("sends someone whose Memberful email address someone here has to sign in with their password, which does", async () => {
      await setUpWithMemberful({ membersOnly: false });
      await joinAsGrace();
      fakeMemberful(gracesAccount);
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("taken"));
      expect((await signInWithPassword({ emailAddress: grace.emailAddress, password: grace.password })).status).toBe(201);
      expect(await identities()).toEqual([]);
    });

    it("is offered on the sign-in page while it's on, once the deployment has the keys", async () => {
      expect(await offersMemberful()).toBe(false);
      const administrator = await setUp();
      expect(await offersMemberful()).toBe(false);
      await turnMemberful(administrator, true, { membersOnly: false });
      expect(await offersMemberful()).toBe(true);
      expect(await offersMemberful({})).toBe(false);
      await turnMemberful(administrator, true);
      expect(await offersMemberful()).toBe(true);
    });
  });

  describe("once it's off", () => {
    it("still signs in those who joined with it, offering it on the sign-in page, but nobody new", async () => {
      const administrator = await setUpWithMemberful({ membersOnly: false });
      const site = fakeMemberful();
      const katherines = await signedInAs(await signInWithMemberful());
      await turnMemberful(administrator, false);
      expect(await offersMemberful()).toBe(true);
      // Started afresh, the Workspace finds that someone signs in with it.
      await evictDurableObject(workspaceStub());
      expect(await offersMemberful()).toBe(true);
      expect(await offersMemberful({})).toBe(false);
      expect(await signedInAs(await signInWithMemberful())).toEqual(katherines);

      site.member = dorothy;
      const refused = await signInWithMemberful();
      expect(locationOf(refused)).toBe(backToSignIn("off"));
      expect(refused.headers.getSetCookie()).toEqual(["__Host-memberful_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure"]);
      expect(await count("users")).toBe(2);
    });

    it("takes Members only with it, giving the join link and members' passwords back", async () => {
      const administrator = await setUp();
      await joinAsGrace();
      await turnMemberful(administrator, true);
      const signInAsGrace = () => signInWithPassword({ emailAddress: grace.emailAddress, password: grace.password });
      expect((await signInAsGrace()).status).toBe(403);
      await turnMemberful(administrator, false);
      expect((await bootstrap()).account).toEqual(account());
      expect((await signInAsGrace()).status).toBe(201);
      expect((await apiWith({ ASSETS: builtPages }, `/join/${await joinCode()}`)).status).toBe(200);
    });
  });

  describe("Sign in with Memberful", () => {
    it("sends the browser to sign in at Memberful with a new state, which a cookie keeps for 10 minutes", async () => {
      await setUpWithMemberful();
      const response = await start("/rooms/abc?tab=pins");
      expect(response.status).toBe(302);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const location = new URL(locationOf(response)!);
      expect(`${location.origin}${location.pathname}`).toBe(`${SITE}/oauth`);
      expect([...location.searchParams.keys()]).toEqual(["response_type", "client_id", "state"]);
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("client_id")).toBe(KEYS.MEMBERFUL_CLIENT_ID);
      const state = location.searchParams.get("state")!;
      expect(state).toMatch(/^[\w-]{43}$/);
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(new RegExp(`^__Host-memberful_state=${state}\\.[\\w-]+; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$`)),
      ]);
      expect(startedWith(await start()).state).not.toBe(state);
    });

    it("goes back to sign in while it's off, or the deployment lacks the keys, which sign in then says", async () => {
      const administrator = await setUp();
      expect(locationOf(await start())).toBe(backToSignIn("off"));
      await turnMemberful(administrator, true);
      const unavailable = await withoutKeys(memberfulSignInPath(null));
      expect(unavailable.status).toBe(302);
      expect(locationOf(unavailable)).toBe(backToSignIn("unavailable"));
      expect(unavailable.headers.get("Set-Cookie")).toBeNull();
    });

    it("goes home before Ember is set up", async () => {
      const response = await start();
      expect(response.status).toBe(302);
      expect(locationOf(response)).toBe(`${origin}/`);
    });

    it("starts at Ember's custom domain, where Memberful sends the browser back", async () => {
      const administrator = await setUpWithMemberful();
      const used = await apiWith({}, "https://chat.example.com/api/account", {
        method: "PATCH",
        headers: as(administrator),
        body: JSON.stringify({ customDomain: "chat.example.com" }),
      });
      expect(used.status).toBe(200);
      const moved = await start("/rooms/abc");
      expect(moved.status).toBe(302);
      expect(locationOf(moved)).toBe("https://chat.example.com/auth/memberful?return_to=%2Frooms%2Fabc");
      expect(moved.headers.get("Set-Cookie")).toBeNull();
      expect(new URL(locationOf(await start("/rooms/abc", "https://chat.example.com"))!).origin).toBe(SITE);
    });
  });

  describe("coming back from Memberful", () => {
    it("signs in someone new with an active membership as a member in every open room, linked to their Memberful account", async () => {
      await setUpWithMemberful();
      const site = fakeMemberful();
      const response = await signInWithMemberful({ returnTo: "/rooms/abc?tab=pins#latest" });
      expect(response.status).toBe(302);
      expect(locationOf(response)).toBe(`${origin}/rooms/abc?tab=pins#latest`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/),
        "__Host-memberful_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
      ]);

      const user = await signedInAs(response);
      expect(user).toEqual({ id: expect.any(String), name: "Katherine Johnson", administrator: false });
      const [stored] = (await workspaceSql("SELECT name, email_address, password_digest, role, status, guest FROM users WHERE id = ?", user.id)) as Array<
        Record<string, unknown>
      >;
      expect(stored).toEqual({ name: "Katherine Johnson", email_address: "katherine@example.com", password_digest: null, role: 0, status: 0, guest: 0 });
      expect(await identities()).toEqual([{ issuer: SITE, subject: "4242", user_id: user.id }]);
      expect(await workspaceSql("SELECT ip_address, user_agent FROM sessions WHERE user_id = ?", user.id)).toEqual([
        { ip_address: IP, user_agent: "Katherine's laptop" },
      ]);
      const { rooms } = (await (await api("/api/sidebar", { headers: { Cookie: cookieOf(response) } })).json()) as Sidebar;
      expect(rooms.map((room) => room.kind !== "direct" && room.name)).toEqual(["general", "random"]);

      // The code went to Memberful's token endpoint with the app's keys, and the token to its member API, neither following a redirect.
      expect(site.requests.map(({ method, url, redirect }) => [method, new URL(url).pathname, redirect])).toEqual([
        ["POST", "/oauth/token", "manual"],
        ["GET", "/api/graphql/member", "manual"],
      ]);
      expect(Object.fromEntries(new URLSearchParams(site.requests[0]!.body))).toEqual({
        grant_type: "authorization_code",
        code: CODE,
        client_id: KEYS.MEMBERFUL_CLIENT_ID,
        client_secret: KEYS.MEMBERFUL_CLIENT_SECRET,
      });
      expect(site.requests[1]!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(new URL(site.requests[1]!.url).searchParams.get("query")).toContain("currentMember");
    });

    it("tells everyone's workspace sockets of someone new, as the people directory lists them", async () => {
      const administrator = await setUpWithMemberful();
      fakeMemberful();
      const workspace = await openWorkspaceSocket(administrator);

      const user = await signedInAs(await signInWithMemberful());
      const { users } = (await (await api("/api/users", { headers: { Cookie: administrator.cookie } })).json()) as Directory;
      const listed = users.find((person) => person.id === user.id);
      expect(listed).toMatchObject({ name: "Katherine Johnson", role: "member", status: "active" });
      expect(await workspace.next()).toEqual({ type: "user.updated", user: listed });
    });

    it("signs the same person in again by their Memberful account, whatever its name and email address are now", async () => {
      await setUpWithMemberful();
      const site = fakeMemberful();
      const first = await signedInAs(await signInWithMemberful());
      site.member = { ...katherine, fullName: "Katherine G. Johnson", email: "kgj@example.com" };
      expect(await signedInAs(await signInWithMemberful())).toEqual(first);
      expect(await count("users")).toBe(2);
      expect(await count("identities")).toBe(1);
      expect(await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", first.id)).toEqual([{ n: 2 }]);
    });

    it("never matches an account by email address: someone new with one someone here has is told so, and nothing is created", async () => {
      await setUpWithMemberful();
      fakeMemberful({ email: ada.emailAddress });
      const response = await signInWithMemberful();
      expect(locationOf(response)).toBe(backToSignIn("taken"));
      expect(response.headers.getSetCookie()).toEqual(["__Host-memberful_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure"]);
      expect(await count("users")).toBe(1);
      expect(await count("identities")).toBe(0);
    });

    it("tells someone without an active membership so, and creates nothing", async () => {
      await setUpWithMemberful();
      fakeMemberful({ subscriptions: [{ active: false }] });
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));
      fakeMemberful({ subscriptions: [] });
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));
      expect(await count("users")).toBe(1);
    });

    it("takes the all access pass as a membership", async () => {
      await setUpWithMemberful();
      fakeMemberful({ unrestrictedAccess: true, subscriptions: [] });
      expect((await signedInAs(await signInWithMemberful())).name).toBe("Katherine Johnson");
    });

    it("tells a member whose membership has lapsed so, but signs an administrator in without one", async () => {
      const administrator = await setUpWithMemberful();
      const site = fakeMemberful();
      const { id } = await signedInAs(await signInWithMemberful());
      site.member = dorothy;
      await signedInAs(await signInWithMemberful());
      const promoted = await api(`/api/account/users/${id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ role: "administrator" }) });
      expect(promoted.status).toBe(200);

      site.member = { ...dorothy, subscriptions: [{ active: false }] };
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));
      site.member = { ...katherine, subscriptions: [{ active: false }] };
      expect(await signedInAs(await signInWithMemberful())).toEqual({ id, name: "Katherine Johnson", administrator: true });
    });

    it("refuses someone linked who has been removed", async () => {
      const administrator = await setUpWithMemberful();
      fakeMemberful();
      const { id } = await signedInAs(await signInWithMemberful());
      expect((await api(`/api/account/users/${id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
      const response = await signInWithMemberful();
      expect(locationOf(response)).toBe(backToSignIn("refused"));
      expect(await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", id)).toEqual([{ n: 0 }]);
    });

    it("names someone new by their email address without a full name, and Member without either, cutting a long name, and never Ember", async () => {
      await setUpWithMemberful();
      const site = fakeMemberful({ fullName: " " });
      expect((await signedInAs(await signInWithMemberful())).name).toBe("katherine");
      site.member = { ...katherine, id: "4243", fullName: null, email: null };
      const unnamed = await signedInAs(await signInWithMemberful());
      expect(unnamed.name).toBe("Member");
      expect(await workspaceSql("SELECT email_address FROM users WHERE id = ?", unnamed.id)).toEqual([{ email_address: null }]);
      site.member = { ...katherine, id: "4244", fullName: `${"K".repeat(99)}😀`, email: "long@example.com" };
      expect((await signedInAs(await signInWithMemberful())).name).toBe("K".repeat(99));
      // The AI assistant's name, which is reserved, is passed over.
      site.member = { ...katherine, id: "4245", fullName: "EMBER", email: "kj@example.com" };
      expect((await signedInAs(await signInWithMemberful())).name).toBe("kj");
      site.member = { ...katherine, id: "4246", fullName: "Ember", email: "ember@example.com" };
      expect((await signedInAs(await signInWithMemberful())).name).toBe("Member");
    });

    it("passes over an AI agent's name too, even while Ember AI is off", async () => {
      const administrator = await setUpWithMemberful();
      // As making an agent called `name` leaves it once Ember AI is turned off.
      const agentCalled = async (id: string, name: string) => {
        const now = new Date().toISOString();
        await workspaceSql("INSERT INTO users (id, name, role, status, created_at, updated_at) VALUES (?, ?, 2, 1, ?, ?)", id, name, now, now);
        await workspaceSql(
          `INSERT INTO agents (user_id, description, instructions, model, model_name, format, thinking, answer_length, every_open_room, created_by, updated_by, created_at, updated_at)
            VALUES (?1, 'Sums up threads', 'Sum up.', 'anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'messages', 'off', 'short', 1, ?2, ?2, ?3, ?3)`,
          id,
          administrator.user.id,
          now,
        );
      };
      await agentCalled("0agent", "katherine johnson");
      const site = fakeMemberful();
      expect((await signedInAs(await signInWithMemberful())).name).toBe("katherine");
      site.member = { ...katherine, id: "4243", email: null };
      expect((await signedInAs(await signInWithMemberful())).name).toBe("Member");
      await agentCalled("1agent", "MEMBER");
      site.member = { ...katherine, id: "4244", email: null };
      expect((await signedInAs(await signInWithMemberful())).name).toBe("Member 2");
    });

    it("signs nobody in with a state this browser didn't start with, or without a code, and asks Memberful nothing", async () => {
      await setUpWithMemberful();
      const site = fakeMemberful();
      const { state, cookie } = startedWith(await start());
      for (const [params, sent] of [
        [{ code: CODE, state: "someone-elses-state" }, cookie],
        [{ code: CODE, state }, undefined],
        [{ code: CODE }, cookie],
        [{ state }, cookie],
        [{ code: CODE, state }, `${cookie.split(".")[0]}`],
      ] as Array<[Record<string, string>, string | undefined]>) {
        const response = await callback(params, sent);
        expect(locationOf(response), JSON.stringify(params)).toBe(backToSignIn("failed"));
        expect(response.headers.getSetCookie()).toEqual(["__Host-memberful_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure"]);
      }
      expect(site.requests).toEqual([]);
      expect(await count("users")).toBe(1);
    });

    it("signs nobody in when Memberful refuses the code, or doesn't answer as it should", async () => {
      await setUpWithMemberful();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { state, cookie } = startedWith(await start());
      fakeMemberful();
      expect(locationOf(await callback({ code: "a-code-memberful-never-gave", state }, cookie))).toBe(backToSignIn("failed"));
      expect(error).toHaveBeenLastCalledWith("Memberful's token endpoint answered 400");

      fakeMemberful(null);
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("failed"));
      expect(error).toHaveBeenLastCalledWith("Memberful's member endpoint answered 200 without what it should");
      fakeMemberful({ id: 4242 as unknown as string });
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("failed"));

      vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network connection lost"));
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("failed"));
      expect(error).toHaveBeenLastCalledWith("Signing in with Memberful failed:", "TypeError");
      expect(await count("users")).toBe(1);
      // Nothing Memberful sent, nor the keys, reaches the log.
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/ember-client-secret|an-access-token|katherine/);
    });

    it("counts each try against the address's sign-in limit, which password sign-ins share", async () => {
      await setUpWithMemberful();
      const site = fakeMemberful();
      for (let attempt = 0; attempt < 10; attempt++) expect((await signInWithPassword({ emailAddress: ada.emailAddress, password: "wrong" })).status).toBe(401);
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("refused"));
      expect(site.requests).toEqual([]);
      expect((await signedInAs(await signInWithMemberful({ ip: "203.0.113.21" }))).name).toBe("Katherine Johnson");
    });

    it("answers 429 to an address that's banned", async () => {
      const administrator = await setUpWithMemberful();
      fakeMemberful();
      // Banning Katherine bans the address she signed in from.
      const banned: UserId = (await signedInAs(await signInWithMemberful({ ip: "203.0.113.66" }))).id;
      expect((await api(`/api/users/${banned}/ban`, { method: "POST", headers: as(administrator) })).status).toBe(200);
      const response = await signInWithMemberful({ ip: "203.0.113.66" });
      expect(response.status).toBe(429);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    });

    it("goes home, rather than to another site or a page that isn't the workspace's, after signing in", async () => {
      await setUpWithMemberful();
      fakeMemberful();
      // The last is short, but too long to keep once its address escapes it.
      for (const returnTo of [
        "https://example.com/rooms/abc",
        "//example.com/rooms/abc",
        "/api/me",
        `/rooms/${"a".repeat(1024)}`,
        `/rooms/abc?q=${"é".repeat(200)}`,
      ]) {
        expect(locationOf(await signInWithMemberful({ returnTo })), returnTo).toBe(`${origin}/`);
      }
      expect(locationOf(await signInWithMemberful())).toBe(`${origin}/`);
    });

    it("signs nobody new in once an administrator has turned it off, nor anyone once the deployment has lost the keys", async () => {
      const administrator = await setUpWithMemberful();
      fakeMemberful();
      const { state, cookie } = startedWith(await start());
      await turnMemberful(administrator, false);
      expect(locationOf(await callback({ code: CODE, state }, cookie))).toBe(backToSignIn("off"));

      await turnMemberful(administrator, true);
      const again = startedWith(await start());
      const unavailable = await withoutKeys(`${MEMBERFUL_CALLBACK_PATH}?${new URLSearchParams({ code: CODE, state: again.state })}`, {
        headers: { Cookie: again.cookie },
      });
      expect(locationOf(unavailable)).toBe(backToSignIn("unavailable"));
      expect(await count("users")).toBe(1);
    });
  });
});

/** The hex HMAC-SHA256 of `body` under `secret`, as Memberful signs a webhook. */
async function signatureOf(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
}

/**
 * Memberful's webhook with `payload`, signed as Memberful signs it unless `signature` says otherwise (null
 * for none), to a deployment with every key unless `keys` says otherwise.
 */
async function webhook(payload: unknown, { signature, keys = ALL_KEYS }: { signature?: string | null; keys?: Partial<Env> } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const signed = signature === undefined ? await signatureOf(body) : signature;
  const headers = { "Content-Type": "application/json", ...(signed === null ? {} : { "X-Memberful-Webhook-Signature": signed }) };
  return apiWith(keys, MEMBERFUL_WEBHOOK_PATH, { method: "POST", headers, body });
}

/** Memberful's webhook that a subscription of `member`'s changed, as `event`, naming them by their id, a number. */
const subscriptionChanged = (member: { id: string }, event = "subscription.deactivated") => ({
  event,
  subscription: { id: 101, active: false, autorenew: false, member: { id: Number(member.id), email: "someone@example.com" } },
});

/**
 * Every webhook Memberful sends, each as its webhook event reference shows its payload
 * (memberful.com/docs/api-reference/webhook-event-reference): those about a member, `member`, naming them
 * by their id, a number, as a member's own events, their subscriptions' and their orders' do, and those
 * about nobody's membership, a plan's price's, which it sends as `subscription`, and a download's.
 */
function memberfulEvents(member: { id: string }) {
  const id = Number(member.id);
  const about = { id, email: "someone@example.com", first_name: "Someone", full_name: "Someone Else", unrestricted_access: false };
  const pass = { id: 7, name: "Members" };
  const subscription = { id: 101, active: true, autorenew: true, member_id: id, member: about, pass, subscription_plan: { id: 3, label: "$10/month", name: "Monthly" } };
  const order = { uuid: "4DACB7B0-B728-0130-F9E8-102B343DC979", number: "4DACB7B0", total: 9900, member: about, products: [], subscriptions: [{ id: 101, active: true, pass }] };
  const plan = { id: 3, price: 1000, name: "Monthly", label: "$10/month", renewal_period: "monthly", for_sale: true, pass, type: "standard_plan" };
  const product = { id: 5, name: "Sample download", price: 1000, for_sale: true, type: "download" };
  return {
    aboutMember: [
      { event: "member_signup", member: about },
      { event: "member_updated", member: about, changed: { email: ["old_email@example.com", about.email] } },
      { event: "member.deleted", member: { deleted: true, id } },
      { event: "tax_id.updated", member: about, tax_id: { country: "FR", type: "eu_vat", value: "FR1234567890" } },
      { event: "custom_fields.updated", member: about, custom_fields: [{ field: { id: 1, label: "T-shirt size" }, value: "M" }] },
      ...["created", "updated", "activated", "reactivated", "deactivated", "deleted"].map((change) => ({ event: `subscription.${change}`, subscription })),
      // A renewal's order names nobody: its subscription does.
      { event: "subscription.renewed", subscription, order: { uuid: order.uuid, status: "completed", total: 9900 } },
      ...["purchased", "refunded", "suspended", "completed"].map((status) => ({ event: `order.${status}`, order: { ...order, status } })),
    ],
    aboutNobody: [
      ...["created", "updated", "deleted"].map((change) => ({ event: `subscription_plan.${change}`, subscription: plan })),
      ...["created", "updated", "deleted"].map((change) => ({ event: `download.${change}`, product })),
    ],
  };
}

/** A test run while the Workspace has every Memberful key too, as a deployment that hears Memberful's webhooks does. */
const hearingWebhooks = (run: () => Promise<void>) => () => withWorkspaceEnv(ALL_KEYS, run);

/** Someone's status as the people directory lists it to `viewer`. */
async function statusOf(viewer: Session, id: UserId): Promise<UserStatus | undefined> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === id)?.status;
}

/** The membership checks queued, by subject, with how many times in a row Memberful failed to answer each. */
const queuedChecks = () => workspaceSql("SELECT subject, attempts FROM membership_checks ORDER BY subject");

/** Waits for the Workspace's alarm to have checked every membership queued. */
const checked = () => vi.waitFor(async () => expect(await queuedChecks()).toEqual([]), { timeout: 5_000 });

/** Queues checking the memberships of `members` as webhooks do, but without setting the alarm, which a test then runs. */
async function queueChecks(...members: Array<{ id: string }>): Promise<void> {
  for (const { id } of members) await workspaceSql("INSERT INTO membership_checks (issuer, subject, queued_at, due_at) VALUES (?, ?, ?, ?)", SITE, id, Date.now(), Date.now());
}

/** Signs in with Memberful as whoever the fake site's member API describes, from `ip`, answering the session. */
async function memberfulSession(ip = IP): Promise<Session> {
  const response = await signInWithMemberful({ ip });
  return { user: shown(await signedInAs(response)), cookie: cookieOf(response) };
}

/** Signs in with Memberful as `member`, whom the fake site's member API describes meanwhile, from `ip`, answering the session. */
async function memberfulSessionOf(member: MemberfulMember, site: { member: MemberfulMember | null }, ip = IP): Promise<Session> {
  const described = site.member;
  site.member = member;
  try {
    return await memberfulSession(ip);
  } finally {
    site.member = described;
  }
}

/** When the Workspace's alarm is set for, if it is. */
const workspaceAlarm = () => runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => state.storage.getAlarm());

/**
 * Waits for the Workspace's alarm to have delivered what the changes before queued, which it has once
 * nothing is due before the next day's catch-up, so a test can run it itself.
 */
const idle = () => vi.waitFor(async () => expect(await workspaceAlarm()).toBeGreaterThan(Date.now() + 60 * 60 * 1000), { timeout: 5_000 });

/** Whether `session` still signs someone in. */
const signsIn = async (session: Session) => (await api("/api/me", { headers: as(session) })).status === 200;

describe("Memberful memberships", () => {
  describe("webhooks", () => {
    it("are heard once the deployment has the API key and the webhook's secret, which administrators' settings say", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const administrator = await setUpWithMemberful();
      const settings = async (changes: Partial<Env>) =>
        ((await (await apiWith(changes, "/api/account", { headers: as(administrator) })).json()) as WorkspaceSettings).memberfulWebhooks;
      expect(await settings(ALL_KEYS)).toBe(true);
      expect(await settings(KEYS)).toBe(false);
      expect(await settings({ ...ALL_KEYS, MEMBERFUL_API_KEY: " " })).toBe(false);
      expect(await settings({ ...ALL_KEYS, MEMBERFUL_WEBHOOK_SECRET: undefined })).toBe(false);
      // Without the sign-in keys, there's no site to ask.
      expect(await settings({ MEMBERFUL_API_KEY: API_KEY, MEMBERFUL_WEBHOOK_SECRET: WEBHOOK_SECRET })).toBe(false);

      for (const keys of [KEYS, { ...ALL_KEYS, MEMBERFUL_API_KEY: undefined }, { ...ALL_KEYS, MEMBERFUL_WEBHOOK_SECRET: "" }]) {
        expect((await webhook(subscriptionChanged(katherine), { keys })).status).toBe(404);
      }
      expect(errors).toHaveBeenCalledWith("A Memberful webhook came, but Ember lacks the webhook's secret or the custom app's API key, so it's refused");
    });

    it(
      "are refused unless Memberful's signature checks out, or when they're too large, and only taken as a POST",
      hearingWebhooks(async () => {
        await setUpWithMemberful();
        fakeMemberful();
        await memberfulSession();
        const payload = subscriptionChanged(katherine);
        const body = JSON.stringify(payload);
        for (const signature of [null, "", "00".repeat(32), await signatureOf(body, "another secret"), await signatureOf(`${body} `), "not hex at all"]) {
          expect((await webhook(payload, { signature })).status, String(signature)).toBe(401);
        }
        const tooLarge = { ...payload, padding: "x".repeat(1024 * 1024) };
        expect((await webhook(tooLarge)).status).toBe(413);
        expect((await apiWith(ALL_KEYS, MEMBERFUL_WEBHOOK_PATH)).status).toBe(404);
        expect(await queuedChecks()).toEqual([]);
      }),
    );

    it(
      "queue checking the membership of the linked member one is about, however it names them, and nobody else's",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        await memberfulSession();
        const named = [
          subscriptionChanged(katherine, "subscription.renewed"),
          { event: "member_updated", member: { id: 4242, email: "katherine@example.com" } },
          { event: "order.suspended", order: { uuid: "an-order", member: { id: 4242 } } },
        ];
        for (const payload of named) {
          expect((await webhook(payload)).status).toBe(200);
          await checked();
          expect(askedAfter(site.requests).at(-1), payload.event).toEqual(["4242"]);
        }

        const asked = site.requests.length;
        // Someone Memberful has who isn't linked here, an administrator, and an event that's about nobody.
        const promoted = await api(`/api/account/users/${(await memberfulSessionOf(dorothy, site)).user.id}`, {
          method: "PATCH",
          headers: as(administrator),
          body: JSON.stringify({ role: "administrator" }),
        });
        expect(promoted.status).toBe(200);
        const planChanged = { event: "subscription_plan.updated", subscription: { id: 3, name: "Monthly", pass: { id: 1, name: "Members" } } };
        for (const payload of [subscriptionChanged({ id: "9999" }), subscriptionChanged(dorothy), planChanged, "not an object"]) {
          expect((await webhook(payload)).status).toBe(200);
        }
        expect(await queuedChecks()).toEqual([]);
        expect(site.requests.slice(asked).filter(({ url }) => url === `${SITE}/api/graphql`)).toEqual([]);
      }),
    );

    it(
      "answer 200 to every event Memberful sends, checking the membership of the member one is about, whatever it's called, and nobody's for one about a plan, a download or nothing Ember knows of",
      hearingWebhooks(async () => {
        await setUpWithMemberful();
        const site = fakeMemberful();
        await memberfulSession();
        const { aboutMember, aboutNobody } = memberfulEvents(katherine);
        for (const payload of aboutMember) {
          const asked = askedAfter(site.requests).length;
          expect((await webhook(payload)).status, payload.event).toBe(200);
          await checked();
          expect(askedAfter(site.requests).slice(asked), payload.event).toEqual([["4242"]]);
        }

        const asked = site.requests.length;
        const unheardOf = [{ event: "member.renamed", account: { id: 4242 } }, { event: "something.new" }, {}, []];
        for (const payload of [...aboutNobody, ...unheardOf]) expect((await webhook(payload)).status, JSON.stringify(payload)).toBe(200);
        expect(await queuedChecks()).toEqual([]);
        expect(site.requests.slice(asked)).toEqual([]);
      }),
    );

    it(
      "are heard once Memberful is off too, since those who joined with it keep signing in with it",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        await turnMemberful(administrator, false);
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        expect((await webhook(subscriptionChanged(katherine))).status).toBe(200);
        await checked();
        expect(await statusOf(administrator, id)).toBe("suspended");
      }),
    );

    it(
      "start no daily check while nobody here is linked to the site, whether Memberful is on or not, and one started before anyone was is forgotten",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        fakeMemberful();
        expect((await webhook(subscriptionChanged(katherine))).status).toBe(200);
        await turnMemberful(administrator, false);
        expect((await webhook(subscriptionChanged(katherine))).status).toBe(200);
        expect(await queuedChecks()).toEqual([]);
        expect(await count("membership_catch_ups")).toBe(0);

        // As turning Memberful on did before anyone signed in with it, once.
        await workspaceSql("INSERT INTO membership_catch_ups (issuer, due_at) VALUES (?, ?)", SITE, Date.now());
        await runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => state.storage.setAlarm(Date.now() + 60 * 60 * 1000));
        expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
        expect(await count("membership_catch_ups")).toBe(0);
      }),
    );
  });

  describe("checking memberships", () => {
    it(
      "suspends a member whose membership has lapsed, signing them out everywhere, and tells every tab",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const katherineSession = await memberfulSession();
        const id = katherineSession.user.id;
        const theirs = await openWorkspaceSocket(katherineSession);
        const everyone = await openWorkspaceSocket(administrator);
        const rooms = await count("memberships");

        site.member = { ...katherine, subscriptions: [{ active: false }] };
        expect((await webhook(subscriptionChanged(katherine))).status).toBe(200);
        expect((await theirs.closed).code).toBe(4003);
        await checked();
        expect(await statusOf(administrator, id)).toBe("suspended");
        expect(await everyone.next()).toMatchObject({ type: "user.updated", user: { id, status: "suspended" } });
        expect(await signsIn(katherineSession)).toBe(false);
        expect(await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", id)).toEqual([{ n: 0 }]);
        // Still in their rooms, for when it's renewed.
        expect(await count("memberships")).toBe(rooms);
        expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));
        everyone.ws.close(1000);
      }),
    );

    it(
      "lets a suspended member back once their membership is renewed, in the open rooms made meanwhile too",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        await webhook(subscriptionChanged(katherine));
        await checked();
        expect(await statusOf(administrator, id)).toBe("suspended");
        const room = await createRoom("launch", { as: administrator });

        site.member = katherine;
        await webhook(subscriptionChanged(katherine, "subscription.renewed"));
        await checked();
        expect(await statusOf(administrator, id)).toBe("active");
        const session = await memberfulSession();
        expect(session.user.id).toBe(id);
        const { rooms } = (await (await api("/api/sidebar", { headers: as(session) })).json()) as Sidebar;
        expect(rooms.map(({ id }) => id)).toContain(room.id);
      }),
    );

    it(
      "takes a member the Memberful site no longer has as one without a membership",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        site.member = null;
        await webhook({ event: "member.deleted", member: { id: 4242, deleted: true } });
        await checked();
        expect(await statusOf(administrator, id)).toBe("suspended");
      }),
    );

    it(
      "never suspends an administrator, nor changes anyone removed",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        const dorothysId = (await memberfulSessionOf(dorothy, site)).user.id;
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        site.others = [{ ...dorothy, subscriptions: [] }];
        expect((await api(`/api/account/users/${dorothysId}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);

        // Asked about while they were a member, and made an administrator while Memberful answers.
        await idle();
        const answered = Promise.withResolvers<void>();
        site.held = answered.promise;
        await queueChecks(katherine, dorothy);
        const checking = runDurableObjectAlarm(workspaceStub());
        await vi.waitFor(() => expect(askedAfter(site.requests)).toEqual([["4242", "4243"]]));
        const promoted = await api(`/api/account/users/${id}`, { method: "PATCH", headers: as(administrator), body: JSON.stringify({ role: "administrator" }) });
        expect(promoted.status).toBe(200);
        answered.resolve();
        expect(await checking).toBe(true);
        expect(await queuedChecks()).toEqual([]);
        expect(await statusOf(administrator, id)).toBe("active");
        expect(await statusOf(administrator, dorothysId)).toBe("deactivated");

        // And once they're one, nothing about them is checked.
        await webhook(subscriptionChanged(katherine));
        expect(await queuedChecks()).toEqual([]);
      }),
    );

    it(
      "never suspends someone who joined with an invitation, who needs no membership, once they've connected Memberful, as it never does an administrator",
      hearingWebhooks(async () => {
        const { administrator, member } = await setUpWithGrace();
        // As joining with an invitation leaves her.
        await workspaceSql("UPDATE users SET invited_by = ? WHERE id = ?", administrator.user.id, member.user.id);
        const site = fakeMemberful(gracesAccount);
        const back = await finish(await connectionOf(await connect(member, { currentPassword: grace.password })), member);
        expect(locationOf(back)).toBe(backToProfile("connected"));

        site.member = { ...site.member!, subscriptions: [{ active: false }] };
        await idle();
        await queueChecks(site.member);
        expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
        expect(await queuedChecks()).toEqual([]);
        expect(await statusOf(administrator, member.user.id)).toBe("active");
        expect(await signsIn(member)).toBe(true);
        expect((await signedInAs(await signInWithMemberful())).id).toBe(member.user.id);

        // And nothing about her is checked.
        await webhook(subscriptionChanged(site.member));
        expect(await queuedChecks()).toEqual([]);
      }),
    );

    it(
      "puts a check off while Memberful doesn't answer, then asks after each of those members alone",
      hearingWebhooks(async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        const dorothysId = (await memberfulSessionOf(dorothy, site)).user.id;
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        site.others = [dorothy];
        site.down = true;
        await idle();
        await queueChecks(katherine, dorothy);
        expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
        site.down = false;
        expect(await queuedChecks()).toEqual([
          { subject: "4242", attempts: 1 },
          { subject: "4243", attempts: 1 },
        ]);
        expect(errors).toHaveBeenCalledWith("Memberful's admin endpoint answered 502");

        await checked();
        expect(askedAfter(site.requests)).toEqual([["4242", "4243"], ["4242"], ["4243"]]);
        expect(await statusOf(administrator, id)).toBe("suspended");
        expect(await statusOf(administrator, dorothysId)).toBe("active");
      }),
    );

    it(
      "puts a check off when Memberful answers it with an error, rather than taking the member as one without a membership",
      hearingWebhooks(async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const session = await memberfulSession();
        const dorothysId = (await memberfulSessionOf(dorothy, site)).user.id;
        site.others = [dorothy];
        site.failing = [katherine.id];
        await idle();
        await queueChecks(katherine, dorothy);
        expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
        site.failing = [];
        expect(await queuedChecks()).toEqual([
          { subject: "4242", attempts: 1 },
          { subject: "4243", attempts: 1 },
        ]);
        expect(errors).toHaveBeenCalledWith("Memberful's admin endpoint answered 200 without what it should");

        await checked();
        expect(await statusOf(administrator, session.user.id)).toBe("active");
        expect(await statusOf(administrator, dorothysId)).toBe("active");
        expect(await signsIn(session)).toBe(true);
      }),
    );

    it(
      "goes by what Memberful answers though Memberful is turned off while it does",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const session = await memberfulSession();
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        await idle();
        const answered = Promise.withResolvers<void>();
        site.held = answered.promise;
        await queueChecks(katherine);
        const checking = runDurableObjectAlarm(workspaceStub());
        await vi.waitFor(() => expect(askedAfter(site.requests)).toEqual([["4242"]]));

        await turnMemberful(administrator, false);
        answered.resolve();
        expect(await checking).toBe(true);
        expect(await statusOf(administrator, session.user.id)).toBe("suspended");
        expect(await signsIn(session)).toBe(false);
      }),
    );

    it(
      "keeps a suspended member in the private rooms they're in when a room's settings are saved, for when it's renewed",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        const room = await createRoom("board", { closedTo: [administrator.user.id, id], as: administrator });
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        await webhook(subscriptionChanged(katherine));
        await checked();
        expect(await statusOf(administrator, id)).toBe("suspended");

        // Saved as its settings page saves it, with the people it lists who are in it, which leaves out anyone suspended.
        const { people } = (await (await api(`/api/rooms/${room.id}/settings`, { headers: as(administrator) })).json()) as RoomSettings;
        const memberIds = people.filter(({ member }) => member).map((person) => person.id);
        expect(memberIds).toEqual([administrator.user.id]);
        const body = JSON.stringify({ name: "Board", kind: "closed", memberIds });
        expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: as(administrator), body })).status).toBe(200);
        expect(await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? AND user_id = ?", room.id, id)).toEqual([{ user_id: id }]);

        site.member = katherine;
        const session = await memberfulSession();
        const { rooms } = (await (await api("/api/sidebar", { headers: as(session) })).json()) as Sidebar;
        expect(rooms.map(({ id }) => id)).toContain(room.id);
      }),
    );

    it(
      "takes a suspended member out of an open room made private, as it does everyone else nobody chose for it",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        const room = await createRoom("lounge", { as: administrator });
        expect(await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? AND user_id = ?", room.id, id)).toEqual([{ user_id: id }]);
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        await webhook(subscriptionChanged(katherine));
        await checked();
        expect(await statusOf(administrator, id)).toBe("suspended");

        const body = JSON.stringify({ name: "Lounge", kind: "closed", memberIds: [administrator.user.id] });
        expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: as(administrator), body })).status).toBe(200);
        expect(await workspaceSql("SELECT user_id FROM memberships WHERE room_id = ?", room.id)).toEqual([{ user_id: administrator.user.id }]);

        site.member = katherine;
        const session = await memberfulSession();
        const { rooms } = (await (await api("/api/sidebar", { headers: as(session) })).json()) as Sidebar;
        expect(rooms.map(({ id }) => id)).not.toContain(room.id);
        expect((await api(`/api/rooms/${room.id}/settings`, { headers: as(session) })).status).toBe(404);
      }),
    );

    it(
      "goes by the newest read of a membership, as a sign-in that began while a check asked Memberful",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        await idle();
        const answered = Promise.withResolvers<void>();
        site.held = answered.promise;
        await queueChecks(katherine);
        const checking = runDurableObjectAlarm(workspaceStub());
        await vi.waitFor(() => expect(askedAfter(site.requests)).toEqual([["4242"]]));

        // Renewed while the check waits for its lapsed answer.
        site.member = katherine;
        site.held = Promise.resolve();
        const session = await memberfulSession();
        answered.resolve();
        expect(await checking).toBe(true);
        expect(await statusOf(administrator, id)).toBe("active");
        expect(await signsIn(session)).toBe(true);
      }),
    );

    it(
      "checks a membership again when a webhook about it comes while it's being checked",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        await idle();
        const answered = Promise.withResolvers<void>();
        site.held = answered.promise;
        await queueChecks(katherine);
        const checking = runDurableObjectAlarm(workspaceStub());
        await vi.waitFor(() => expect(askedAfter(site.requests)).toEqual([["4242"]]));

        site.member = { ...katherine, subscriptions: [{ active: false }] };
        site.held = Promise.resolve();
        expect((await webhook(subscriptionChanged(katherine))).status).toBe(200);
        answered.resolve();
        await checking;
        await checked();
        expect(askedAfter(site.requests)).toEqual([["4242"], ["4242"]]);
        expect(await statusOf(administrator, id)).toBe("suspended");
      }),
    );

    it(
      "checks everyone linked once a day, in case a webhook never came, as many as a request asks after at once",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        const others = Array.from({ length: 25 }, (_, i): MemberfulMember => ({ ...dorothy, id: String(5000 + i), email: `member${i}@example.com` }));
        for (const [i, member] of others.entries()) await memberfulSessionOf(member, site, `198.51.100.${i + 1}`);
        site.member = { ...katherine, subscriptions: [{ active: false }] };
        site.others = others;

        await idle();
        const startedAt = Date.now();
        await workspaceSql("UPDATE membership_catch_ups SET due_at = ?", startedAt);
        expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
        await checked();
        expect(askedAfter(site.requests).map((asked) => asked.length)).toEqual([25, 1]);
        expect(await statusOf(administrator, id)).toBe("suspended");
        const [{ due_at: next }] = (await workspaceSql("SELECT due_at FROM membership_catch_ups WHERE issuer = ?", SITE)) as [{ due_at: number }];
        expect(next).toBeGreaterThanOrEqual(startedAt + 24 * 60 * 60 * 1000);
        expect(next).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
      }),
    );

    it(
      "makes the daily check due as the Workspace starts, if anyone here signs in with Memberful and none is, as once the deployment is given the API key",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const resume = () =>
          runInDurableObject(workspaceStub(), (workspace: Workspace) => (workspace as unknown as { resumeDeliveries(): Promise<void> }).resumeDeliveries());
        // With nobody linked, there's nobody to check.
        await resume();
        expect(await count("membership_catch_ups")).toBe(0);
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        site.member = { ...katherine, subscriptions: [] };
        await turnMemberful(administrator, false);
        await idle();
        // As a deployment that had someone linked before it had the key: nothing was due.
        await workspaceSql("DELETE FROM membership_catch_ups");
        await resume();
        await vi.waitFor(async () => expect(await statusOf(administrator, id)).toBe("suspended"), { timeout: 5_000 });

        // The next, a day off, stays as it is.
        await idle();
        const next = await workspaceSql("SELECT due_at FROM membership_catch_ups");
        await resume();
        expect(await workspaceSql("SELECT due_at FROM membership_catch_ups")).toEqual(next);
      }),
    );

    it(
      "keeps checking everyone linked once a day once Memberful is off",
      hearingWebhooks(async () => {
        const administrator = await setUpWithMemberful();
        const site = fakeMemberful();
        const { id } = (await memberfulSession()).user;
        await turnMemberful(administrator, false);
        site.member = { ...katherine, subscriptions: [] };
        await idle();
        await workspaceSql("UPDATE membership_catch_ups SET due_at = ?", Date.now());
        expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
        await checked();
        expect(askedAfter(site.requests)).toEqual([["4242"]]);
        expect(await statusOf(administrator, id)).toBe("suspended");
      }),
    );

    it(
      "forgets what was queued while the deployment can't ask the admin API",
      hearingWebhooks(async () => {
        await setUpWithMemberful();
        const site = fakeMemberful();
        await memberfulSession();
        await idle();
        await withWorkspaceEnv({ MEMBERFUL_API_KEY: undefined }, async () => {
          await queueChecks(katherine);
          expect(await runDurableObjectAlarm(workspaceStub())).toBe(true);
          expect(await queuedChecks()).toEqual([]);
          expect(await count("membership_catch_ups")).toBe(0);
        });
        expect(askedAfter(site.requests)).toEqual([]);
      }),
    );
  });

  describe("signing in", () => {
    it("suspends a member whose membership has lapsed as they sign in, ending their sessions elsewhere", async () => {
      const administrator = await setUpWithMemberful();
      const site = fakeMemberful();
      const first = await memberfulSession();
      const second = await memberfulSession();
      site.member = { ...katherine, subscriptions: [{ active: false }] };
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));
      expect(await statusOf(administrator, first.user.id)).toBe("suspended");
      expect(await signsIn(first)).toBe(false);
      expect(await signsIn(second)).toBe(false);
    });

    it("lets a suspended member back as they sign in with a renewed membership", async () => {
      const administrator = await setUpWithMemberful();
      const site = fakeMemberful();
      const { id } = (await memberfulSession()).user;
      site.member = { ...katherine, subscriptions: [] };
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("membership"));

      site.member = { ...katherine, unrestrictedAccess: true, subscriptions: [] };
      const session = await memberfulSession();
      expect(session.user.id).toBe(id);
      expect(await statusOf(administrator, id)).toBe("active");
    });

    it("takes a sign-in Memberful answers with an error as one that didn't work, rather than a lapse", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const administrator = await setUpWithMemberful();
      const site = fakeMemberful();
      const session = await memberfulSession();
      site.failing = [katherine.id];
      expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("failed"));
      expect(errors).toHaveBeenLastCalledWith("Memberful's member endpoint answered 200 without what it should");
      expect(await statusOf(administrator, session.user.id)).toBe("active");
      expect(await signsIn(session)).toBe(true);
    });
  });

  it("lets an administrator remove someone suspended", async () => {
    const administrator = await setUpWithMemberful();
    const site = fakeMemberful();
    const { id } = (await memberfulSession()).user;
    site.member = { ...katherine, subscriptions: [] };
    await signInWithMemberful();
    expect((await api(`/api/account/users/${id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
    expect(await statusOf(administrator, id)).toBe("deactivated");
    site.member = katherine;
    expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("refused"));
  });
});

/** Starts connecting Memberful from `session`'s profile with `body`, from `ip`, on a deployment with the keys unless `keys` is false. */
const connect = (session: Session | null, body: MemberfulConnectionStart = {}, { ip = IP, keys = true } = {}) =>
  apiWith(keys ? KEYS : {}, MEMBERFUL_CONNECTIONS_PATH, { method: "POST", headers: { ...as(session), "CF-Connecting-IP": ip }, body: JSON.stringify(body) });

/** Signs in with `person`'s email address and password, coming back to `returnTo` if connecting goes on at Memberful, on a deployment with the keys. */
const signInWithPasswordToConnect = ({ emailAddress, password }: { emailAddress: string; password: string }, returnTo?: string, ip = IP) =>
  withKeys("/api/session", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify({ emailAddress, password, returnTo }) });

/** The state a connection sends the browser to Memberful with, and the cookie that keeps it, from the 202 that started it. */
async function connectionOf(response: Response): Promise<{ state: string; cookie: string }> {
  expect(response.status, await response.clone().text()).toBe(202);
  const location = new URL(((await response.json()) as MemberfulConnection).memberfulConnection);
  expect(`${location.origin}${location.pathname}`).toBe(`${SITE}/oauth`);
  expect(location.searchParams.get("client_id")).toBe(KEYS.MEMBERFUL_CLIENT_ID);
  return { state: location.searchParams.get("state")!, cookie: cookieOf(response) };
}

/** Comes back from Memberful with the connection's state, to a browser with its cookie, signed in as `session` too if given, from `ip`. */
const finish = ({ state, cookie }: { state: string; cookie: string }, session?: Session, ip = IP) =>
  callback({ code: CODE, state }, session ? `${cookie}; ${session.cookie}` : cookie, ip);

/** Where connecting sends a browser signed in back to, its profile, saying how it went. */
const backToProfile = (outcome: string) => `${origin}/users/me/profile?memberful=${outcome}`;

/** `session`'s profile as its page reads it, from a deployment with the keys unless `keys` is false. */
const profileOf = async (session: Session, { keys = true } = {}): Promise<Profile> =>
  ((await (await apiWith(keys ? KEYS : {}, "/api/users/me/profile", { headers: as(session) })).json()) as ProfileAnswer).profile;

/** Grace's account at the Memberful site, with an active subscription. */
const gracesAccount: Partial<MemberfulMember> = { id: "4250", email: grace.emailAddress, fullName: grace.name };
/** The same, as her profile names it once it's connected. */
const GRACES = { name: grace.name, emailAddress: grace.emailAddress };

/** Disconnects Memberful from `session`'s profile with `body`, from `ip`, on a deployment with the keys unless `keys` is false. */
const disconnect = (session: Session | null, body: MemberfulDisconnection = {}, { ip = IP, keys = true } = {}) =>
  apiWith(keys ? KEYS : {}, MEMBERFUL_CONNECTIONS_PATH, { method: "DELETE", headers: { ...as(session), "CF-Connecting-IP": ip }, body: JSON.stringify(body) });

/** Connects Grace's Memberful account from `member`'s profile, her session, with her password, `password`, at a fake Memberful site that describes it. */
async function connectGrace(member: Session, password = grace.password): Promise<ReturnType<typeof fakeMemberful>> {
  const site = fakeMemberful(gracesAccount);
  expect(locationOf(await finish(await connectionOf(await connect(member, { currentPassword: password })), member))).toBe(backToProfile("connected"));
  return site;
}

/** Saves `session`'s profile as its form does, with `changes`, on a deployment with the keys, or with `keys`. */
const saveProfile = (session: Session, changes: unknown, keys: Partial<Env> = KEYS) =>
  apiWith(keys, "/api/users/me/profile", { method: "PATCH", headers: as(session), body: JSON.stringify(changes) });

/** Every linked account, with what it says of itself. */
const linkedAccounts = () => workspaceSql("SELECT issuer, subject, user_id, name, email_address FROM identities");

/** Where Chrome's push service takes the pushes of a subscription labelled `label`. */
const endpointOf = (label: string) => `https://fcm.googleapis.com/fcm/send/${label}`;

/** Saves a push subscription for `session`, at `endpointOf(label)`. */
async function subscribe(session: Session, label: string): Promise<void> {
  const { p256dh, auth } = await pushBrowser();
  const body = JSON.stringify({ endpoint: endpointOf(label), p256dhKey: p256dh, authKey: auth });
  expect((await api("/api/push-subscriptions", { method: "POST", headers: as(session), body })).status).toBe(204);
}

const subscriptions = () => workspaceSql("SELECT user_id, endpoint FROM push_subscriptions ORDER BY endpoint");

/** Sets Ember up with Ada as its administrator and Grace, who joined with a password, then makes Memberful members only. */
async function setUpWithGrace(): Promise<{ administrator: Session; member: Session }> {
  const administrator = await setUp();
  const member = await joinAsGrace();
  await turnMemberful(administrator, true);
  return { administrator, member };
}

describe("Connect Memberful", () => {
  describe("from your profile", () => {
    it("says whether you've connected a Memberful account, while Memberful is members only", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const guest = await signIn("Visitor");
      expect((await profileOf(member)).memberful).toBeNull();
      await turnMemberful(administrator, true, { membersOnly: false });
      expect((await profileOf(member)).memberful).toBeNull();

      await turnMemberful(administrator, true);
      expect((await profileOf(member)).memberful).toEqual({ membersOnly: true, connected: null });
      expect((await profileOf(administrator)).memberful).toEqual({ membersOnly: true, connected: null });
      expect((await profileOf(member, { keys: false })).memberful).toBeNull();
      // Signed in with just a name, they have nothing to connect.
      expect((await profileOf(guest)).memberful).toBeNull();
    });

    it("connects your account once your password checks out, and keeps you signed in", async () => {
      const { member } = await setUpWithGrace();
      const site = fakeMemberful(gracesAccount);
      const started = await connect(member, { currentPassword: grace.password });
      expect(started.headers.get("Cache-Control")).toBe("no-store");
      const back = await finish(await connectionOf(started), member);
      expect(locationOf(back)).toBe(backToProfile("connected"));
      // Only the state's cookie is forgotten: she's signed in as she was.
      expect(back.headers.getSetCookie()).toEqual([expect.stringMatching(/memberful_state=;/)]);
      expect(await identities()).toEqual([{ issuer: SITE, subject: "4250", user_id: member.user.id }]);
      expect(await signsIn(member)).toBe(true);
      expect((await profileOf(member)).memberful).toEqual({ membersOnly: true, connected: GRACES });
      expect(await count("pending_identities")).toBe(0);

      // From then on she signs in with Memberful as herself, and has nothing more to connect.
      expect((await signedInAs(await signInWithMemberful())).id).toBe(member.user.id);
      const again = await connect(member, { currentPassword: grace.password });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "You've connected Memberful already" });
      expect(site.requests.filter(({ url }) => url === `${SITE}/oauth/token`)).toHaveLength(2);
    });

    it(
      "starts the daily check of memberships once the first account here is connected",
      hearingWebhooks(async () => {
        const { member } = await setUpWithGrace();
        fakeMemberful(gracesAccount);
        expect(await count("membership_catch_ups")).toBe(0);
        const back = await finish(await connectionOf(await connect(member, { currentPassword: grace.password })), member);
        expect(locationOf(back)).toBe(backToProfile("connected"));
        expect(await count("membership_catch_ups")).toBe(1);
      }),
    );

    it("asks for your password, counting it against the sign-in limit", async () => {
      const { member } = await setUpWithGrace();
      const without = await connect(member);
      expect(without.status).toBe(422);
      expect(await without.json()).toEqual({ error: MEMBERFUL_PASSWORD_NEEDED });
      const wrong = await connect(member, { currentPassword: "wrong" });
      expect(wrong.status).toBe(422);
      expect(await wrong.json()).toEqual({ error: CURRENT_PASSWORD_WRONG });
      for (let attempt = 2; attempt < 10; attempt++) expect((await connect(member, { currentPassword: "wrong" })).status).toBe(422);

      const limited = await connect(member, { currentPassword: grace.password });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: SIGN_IN_LIMITED });
      expect(limited.headers.get("Set-Cookie")).toBeNull();
      expect((await connect(member, { currentPassword: grace.password }, { ip: "203.0.113.21" })).status).toBe(202);
      expect(await count("pending_identities")).toBe(1);
    });

    it("connects someone without a password without asking for one", async () => {
      const { member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      // As people without a password keep it.
      await workspaceSql("UPDATE users SET password_digest = '' WHERE id = ?", member.user.id);
      expect(locationOf(await finish(await connectionOf(await connect(member)), member))).toBe(backToProfile("connected"));
    });

    it("answers 401 without a session, and 403 while Memberful isn't members only, to a deployment without the keys, or to a guest", async () => {
      const administrator = await setUp();
      const member = await joinAsGrace();
      const guest = await signIn("Visitor");
      const password = { currentPassword: grace.password };
      expect((await connect(null, password)).status).toBe(401);
      for (const membersOnly of [null, false]) {
        if (membersOnly !== null) await turnMemberful(administrator, true, { membersOnly });
        const off = await connect(member, password);
        expect(off.status).toBe(403);
        expect(await off.json()).toEqual({ error: MEMBERFUL_SIGN_IN_PROBLEMS.unneeded });
      }

      await turnMemberful(administrator, true);
      const unavailable = await connect(member, password, { keys: false });
      expect(unavailable.status).toBe(403);
      expect(await unavailable.json()).toEqual({ error: MEMBERFUL_SIGN_IN_PROBLEMS.unavailable });
      const guests = await connect(guest);
      expect(guests.status).toBe(403);
      expect(await guests.json()).toEqual({ error: "Guests can't connect Memberful" });
      expect(await count("pending_identities")).toBe(0);
    });

    it("connects nothing when the Memberful account is someone else's, or has no membership, or you've connected another", async () => {
      const { administrator, member } = await setUpWithGrace();
      const site = fakeMemberful();
      const katherinesId = (await signedInAs(await signInWithMemberful())).id;
      const password = { currentPassword: grace.password };

      // Signed in at Memberful as Katherine, who has an account here.
      expect(locationOf(await finish(await connectionOf(await connect(member, password)), member))).toBe(backToProfile("claimed"));
      site.member = { ...katherine, ...gracesAccount, subscriptions: [] };
      expect(locationOf(await finish(await connectionOf(await connect(member, password)), member))).toBe(backToProfile("membership"));
      expect(await identities()).toEqual([{ issuer: SITE, subject: "4242", user_id: katherinesId }]);
      expect(await signsIn(member)).toBe(true);

      // An administrator needs no membership, but connects only one account there.
      const adas = { currentPassword: ada.password };
      const ip = "203.0.113.30";
      const [first, second] = [await connectionOf(await connect(administrator, adas, { ip })), await connectionOf(await connect(administrator, adas, { ip }))];
      site.member = { ...katherine, id: "4251", email: ada.emailAddress, fullName: ada.name, subscriptions: [] };
      expect(locationOf(await finish(first, administrator, ip))).toBe(backToProfile("connected"));
      site.member = { ...katherine, id: "4252", email: "ada@elsewhere.example", fullName: ada.name };
      expect(locationOf(await finish(second, administrator, ip))).toBe(backToProfile("another"));
      expect(await identities()).toEqual(expect.arrayContaining([{ issuer: SITE, subject: "4251", user_id: administrator.user.id }]));
      expect(await identities()).toHaveLength(2);
    });

    it("connects someone who joined with an invitation without a membership, as it does an administrator, since they need none", async () => {
      const { administrator, member } = await setUpWithGrace();
      // As joining with an invitation leaves her.
      await workspaceSql("UPDATE users SET invited_by = ? WHERE id = ?", administrator.user.id, member.user.id);
      fakeMemberful({ ...gracesAccount, subscriptions: [] });
      const back = await finish(await connectionOf(await connect(member, { currentPassword: grace.password })), member);
      expect(locationOf(back)).toBe(backToProfile("connected"));
      expect(await identities()).toEqual([{ issuer: SITE, subject: "4250", user_id: member.user.id }]);
    });
  });

  describe("at sign in", () => {
    it("sends a member whose password checks out on to Memberful, which brings them back signed in", async () => {
      const { administrator, member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      const connection = await connectionOf(await signInWithPasswordToConnect(grace, "/rooms/abc?tab=pins"));
      const back = await finish(connection);
      expect(locationOf(back)).toBe(`${origin}/rooms/abc?tab=pins`);
      expect((await signedInAs(back)).id).toBe(member.user.id);
      expect(await identities()).toEqual([{ issuer: SITE, subject: "4250", user_id: member.user.id }]);

      // Once she has, her password signs her in no more, and an administrator's still does.
      const again = await signInWithPasswordToConnect(grace);
      expect(again.status).toBe(403);
      expect(await again.json()).toEqual({ error: MEMBERFUL_SIGN_IN_NEEDED });
      expect((await signInWithPasswordToConnect(ada)).status).toBe(201);
      void administrator;
    });

    it("goes back to sign in, which says why, when connecting doesn't work", async () => {
      await setUpWithGrace();
      fakeMemberful({ ...gracesAccount, subscriptions: [] });
      expect(locationOf(await finish(await connectionOf(await signInWithPasswordToConnect(grace))))).toBe(backToSignIn("membership"));
      expect(await identities()).toEqual([]);
    });

    it("comes back home rather than to a page that isn't the workspace's", async () => {
      await setUpWithGrace();
      fakeMemberful(gracesAccount);
      expect(locationOf(await finish(await connectionOf(await signInWithPasswordToConnect(grace, "https://example.com/rooms/abc"))))).toBe(`${origin}/`);
    });
  });

  describe("each connection", () => {
    it("is good for one try within ten minutes, and never signs anyone in once it's gone", async () => {
      const { member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      const password = { currentPassword: grace.password };
      const late = await connectionOf(await connect(member, password));
      await workspaceSql("UPDATE pending_identities SET created_at = created_at - ?", 10 * 60 * 1000 + 1);
      expect(locationOf(await finish(late, member))).toBe(backToProfile("failed"));
      expect(await count("pending_identities")).toBe(0);

      const used = await connectionOf(await connect(member, password));
      expect(locationOf(await finish(used, member))).toBe(backToProfile("connected"));
      // Brought back again, by another browser, it signs nobody in, though the account is Grace's now.
      const replayed = await finish(used);
      expect(locationOf(replayed)).toBe(backToSignIn("failed"));
      expect(replayed.headers.getSetCookie()).toEqual([expect.stringMatching(/memberful_state=;/)]);
    });

    it("is forgotten once the account is disconnected, so that it can't connect one again", async () => {
      const { member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      // Started in one browser, while another connects the account and disconnects it.
      const started = await connectionOf(await connect(member, { currentPassword: grace.password }));
      await connectGrace(member);
      expect(await count("pending_identities")).toBe(1);
      expect((await disconnect(member, { currentPassword: grace.password })).status).toBe(200);
      expect(await count("pending_identities")).toBe(0);
      expect(locationOf(await finish(started, member))).toBe(backToProfile("failed"));
      expect(await identities()).toEqual([]);
    });

    it("is forgotten once the password that started it is changed, or reset", async () => {
      const { member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      const started = await connectionOf(await connect(member, { currentPassword: grace.password }));
      const changed = await api("/api/users/me/profile", {
        method: "PATCH",
        headers: as(member),
        body: JSON.stringify({ password: "a new password", currentPassword: grace.password }),
      });
      expect(changed.status).toBe(200);
      expect(await count("pending_identities")).toBe(0);
      expect(locationOf(await finish(started, member))).toBe(backToProfile("failed"));

      const before = await connectionOf(await connect(member, { currentPassword: "a new password" }));
      await runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.resetPassword(grace.emailAddress, "recovery digest"));
      expect(await count("pending_identities")).toBe(0);
      expect(locationOf(await finish(before))).toBe(backToSignIn("failed"));
      expect(await identities()).toEqual([]);
    });

    it("connects nothing once the password that started it is reset while Memberful is asked who signed in", async () => {
      const { member } = await setUpWithGrace();
      const site = fakeMemberful(gracesAccount);
      const started = await connectionOf(await connect(member, { currentPassword: grace.password }));
      const answered = Promise.withResolvers<void>();
      site.signInHeld = answered.promise;
      const finishing = finish(started);
      // The callback has taken the connection by now, so the reset has none to forget.
      await vi.waitFor(() => expect(site.requests.some(({ url }) => new URL(url).pathname === "/api/graphql/member")).toBe(true));
      expect(await count("pending_identities")).toBe(0);
      await runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.resetPassword(grace.emailAddress, "recovery digest"));
      answered.resolve();
      expect(locationOf(await finishing)).toBe(backToSignIn("refused"));
      expect(await identities()).toEqual([]);
    });

    it("connects nothing once Memberful stops being members only meanwhile, since their password signs them in", async () => {
      const { administrator, member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      const started = await connectionOf(await connect(member, { currentPassword: grace.password }));
      await turnMemberful(administrator, true, { membersOnly: false });
      expect(locationOf(await finish(started, member))).toBe(backToProfile("unneeded"));
      expect(await identities()).toEqual([]);
      expect(await signsIn(member)).toBe(true);
    });

    it("connects nothing to someone removed meanwhile", async () => {
      const { administrator, member } = await setUpWithGrace();
      fakeMemberful(gracesAccount);
      const started = await connectionOf(await connect(member, { currentPassword: grace.password }));
      expect((await api(`/api/account/users/${member.user.id}`, { method: "DELETE", headers: as(administrator) })).status).toBe(200);
      expect(locationOf(await finish(started))).toBe(backToSignIn("refused"));
      expect(await identities()).toEqual([]);
    });

    it("starts at Ember's custom domain, where Memberful sends the browser back, and goes there from a tab left open elsewhere", async () => {
      const { administrator, member } = await setUpWithGrace();
      const used = await apiWith({}, "https://chat.example.com/api/account", {
        method: "PATCH",
        headers: as(administrator),
        body: JSON.stringify({ customDomain: "chat.example.com" }),
      });
      expect(used.status).toBe(200);

      // From her profile, or as she signs in, at the address Ember has moved from, it keeps nothing.
      const fromProfile = await connect(member, { currentPassword: grace.password });
      expect(fromProfile.status).toBe(202);
      expect(await fromProfile.json()).toEqual({ memberfulConnection: "https://chat.example.com/users/me/profile" });
      expect(fromProfile.headers.get("Set-Cookie")).toBeNull();
      expect(fromProfile.headers.get("Cache-Control")).toBe("no-store");
      const atSignIn = await signInWithPasswordToConnect(grace, "/rooms/abc?tab=pins");
      expect(atSignIn.status).toBe(202);
      expect(await atSignIn.json()).toEqual({ memberfulConnection: "https://chat.example.com/rooms/abc?tab=pins" });
      expect(atSignIn.headers.get("Set-Cookie")).toBeNull();
      expect(await count("pending_identities")).toBe(0);

      const there = await apiWith(KEYS, `https://chat.example.com${MEMBERFUL_CONNECTIONS_PATH}`, {
        method: "POST",
        headers: { ...as(member), "CF-Connecting-IP": IP },
        body: JSON.stringify({ currentPassword: grace.password }),
      });
      expect((await connectionOf(there)).cookie).toMatch(/^__Host-memberful_state=/);
      expect(await count("pending_identities")).toBe(1);
    });
  });
});

describe("The Memberful account connected", () => {
  it("is named on your profile as Memberful describes it, whether or not Memberful is members only", async () => {
    const { administrator, member } = await setUpWithGrace();
    await connectGrace(member);
    expect(await linkedAccounts()).toEqual([{ issuer: SITE, subject: "4250", user_id: member.user.id, name: grace.name, email_address: grace.emailAddress }]);
    expect((await profileOf(member)).memberful).toEqual({ membersOnly: true, connected: GRACES });
    // Her password signs her in again, but so does Memberful, and the section says so.
    await turnMemberful(administrator, true, { membersOnly: false });
    expect((await profileOf(member)).memberful).toEqual({ membersOnly: false, connected: GRACES });
    await turnMemberful(administrator, false);
    expect((await profileOf(member)).memberful).toEqual({ membersOnly: false, connected: GRACES });
    // Though not to a deployment without the keys, where there's no Memberful site.
    expect((await profileOf(member, { keys: false })).memberful).toBeNull();
    expect((await profileOf(administrator)).memberful).toBeNull();
  });

  it("is described anew each time it signs you in, and as nothing until then for one connected before Ember kept that", async () => {
    const { member } = await setUpWithGrace();
    const site = await connectGrace(member);
    await workspaceSql("UPDATE identities SET name = NULL, email_address = NULL");
    expect((await profileOf(member)).memberful).toEqual({ membersOnly: true, connected: { name: null, emailAddress: null } });

    site.member = { ...site.member!, fullName: "Grace Brewster Murray Hopper", email: "grace@navy.example" };
    expect((await signedInAs(await signInWithMemberful())).id).toBe(member.user.id);
    expect((await profileOf(member)).memberful).toEqual({ membersOnly: true, connected: { name: "Grace Brewster Murray Hopper", emailAddress: "grace@navy.example" } });
    expect(await linkedAccounts()).toEqual([{ issuer: SITE, subject: "4250", user_id: member.user.id, name: "Grace Brewster Murray Hopper", email_address: "grace@navy.example" }]);
  });

  it("is named for someone who joined with Memberful too, who signs in with it alone", async () => {
    await setUpWithMemberful({ membersOnly: false });
    fakeMemberful();
    const session = await memberfulSession();
    expect((await profileOf(session)).memberful).toEqual({ membersOnly: false, connected: { name: katherine.fullName, emailAddress: katherine.email } });
    expect((await profileOf(session)).password).toBe(false);
  });

  it("goes without a name when Memberful has no full name for it, though the person is named here by their email address", async () => {
    await setUpWithMemberful({ membersOnly: false });
    const site = fakeMemberful();
    const session = await memberfulSessionOf({ ...katherine, id: "4243", fullName: null, email: "dorothy@example.com" }, site);
    expect(session.user.name).toBe("dorothy");
    expect((await profileOf(session)).memberful).toEqual({ membersOnly: false, connected: { name: null, emailAddress: "dorothy@example.com" } });
  });
});

describe("A new password", () => {
  it("disconnects the Memberful account connected with the one it replaces, as a reset does", async () => {
    const { member } = await setUpWithGrace();
    const site = await connectGrace(member);
    const changed = await saveProfile(member, { password: "a new password", currentPassword: grace.password });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as ProfileAnswer).profile.memberful).toEqual({ membersOnly: true, connected: null });
    expect(await identities()).toEqual([]);
    expect(await signsIn(member)).toBe(true);
    // Memberful knows her account, but it's connected to nobody here, and her email address is hers.
    expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("taken"));

    await connectGrace(member, "a new password");
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.resetPassword(grace.emailAddress, "recovery digest"));
    expect(await identities()).toEqual([]);
    expect(await signsIn(member)).toBe(false);
    expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("taken"));
    void site;
  });

  it("is refused to someone without one whom Memberful signs in, as it does while the deployment has its keys, whether or not Memberful is on", async () => {
    const administrator = await setUpWithMemberful({ membersOnly: false });
    fakeMemberful();
    const session = await memberfulSession();
    const elsewhere = await memberfulSession();
    for (const on of [true, false]) {
      await turnMemberful(administrator, on, { membersOnly: false });
      for (const changes of [{ password: "a long enough password" }, { password: "a long enough password", emailAddress: "katherine@nasa.example" }]) {
        const refused = await saveProfile(session, changes);
        expect(refused.status).toBe(422);
        expect(await refused.json()).toEqual({ error: PASSWORD_WITH_MEMBERFUL });
      }
    }
    // Nothing was saved, and their other sessions go on, as a new password would end them.
    expect(await profileOf(session)).toMatchObject({ password: false, emailAddress: katherine.email });
    expect(await signsIn(elsewhere)).toBe(true);
    expect(await identities()).toEqual([{ issuer: SITE, subject: katherine.id, user_id: session.user.id }]);
    // The rest of their profile is theirs to change as before, their email address included.
    expect((await saveProfile(session, { emailAddress: "katherine@nasa.example" })).status).toBe(200);
    expect((await signedInAs(await signInWithMemberful())).id).toBe(session.user.id);
  });

  it("keeps the Memberful account of someone without a password, as they set their first where Memberful doesn't sign them in", async () => {
    await setUpWithMemberful({ membersOnly: false });
    fakeMemberful();
    const session = await memberfulSession();
    // At another Memberful site, where they'd be someone new, as at a deployment without the keys.
    const saved = await saveProfile(session, { password: "a long enough password" }, { ...KEYS, MEMBERFUL_URL: "https://another.memberful.com/" });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as ProfileAnswer).profile.password).toBe(true);
    expect(await identities()).toEqual([{ issuer: SITE, subject: katherine.id, user_id: session.user.id }]);
    // Back at the site, either signs them in.
    expect((await signedInAs(await signInWithMemberful())).id).toBe(session.user.id);
    expect((await signInWithPassword({ emailAddress: katherine.email, password: "a long enough password" })).status).toBe(201);
  });

  it("is someone's first to set at a deployment without Memberful's keys, which has no Memberful to sign them in", async () => {
    await setUpWithMemberful({ membersOnly: false });
    fakeMemberful();
    const session = await memberfulSession();
    const saved = await saveProfile(session, { password: "a long enough password" }, {});
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as ProfileAnswer).profile).toMatchObject({ password: true, memberful: null });
    expect(await identities()).toEqual([{ issuer: SITE, subject: katherine.id, user_id: session.user.id }]);
  });

  it("keeps the Memberful account of someone without an email address, which their password can't sign them in without, until they add one", async () => {
    await setUpWithMemberful({ membersOnly: false });
    const site = fakeMemberful();
    const session = await memberfulSessionOf({ ...katherine, id: "4243", fullName: "Dorothy Vaughan", email: null }, site);
    const linked = [{ issuer: SITE, subject: "4243", user_id: session.user.id }];
    // Her first, where Memberful doesn't sign her in.
    expect((await saveProfile(session, { password: "a long enough password" }, {})).status).toBe(200);
    const changed = await saveProfile(session, { password: "another long password", currentPassword: "a long enough password" });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as ProfileAnswer).profile.memberful).toEqual({ membersOnly: false, connected: { name: "Dorothy Vaughan", emailAddress: null } });
    expect(await identities()).toEqual(linked);
    // A new password saved with an email address, which it can sign them in by, disconnects it.
    const withEmail = await saveProfile(session, { emailAddress: "dorothy@example.com", password: "a third long password", currentPassword: "another long password" });
    expect(withEmail.status).toBe(200);
    // Nothing to show anymore, since Memberful isn't members only.
    expect(((await withEmail.json()) as ProfileAnswer).profile.memberful).toBeNull();
    expect(await identities()).toEqual([]);
    expect((await signInWithPassword({ emailAddress: "dorothy@example.com", password: "a third long password" })).status).toBe(201);
  });

  it("stops the sign-in page offering Memberful once nobody is connected to it and Memberful is off", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    await turnMemberful(administrator, true);
    await connectGrace(member);
    await turnMemberful(administrator, false);
    expect(await offersMemberful()).toBe(true);

    expect((await saveProfile(member, { password: "a new password", currentPassword: grace.password })).status).toBe(200);
    expect(await offersMemberful()).toBe(false);
    // And a Workspace started afresh agrees.
    await evictDurableObject(workspaceStub());
    expect(await offersMemberful()).toBe(false);
  });
});

describe("Disconnect Memberful", () => {
  it("disconnects your account once your password checks out, ending your other sessions but this browser's", async () => {
    const { member } = await setUpWithGrace();
    await connectGrace(member);
    // Signed in with Memberful on another device, with a push subscription on each.
    const other = await memberfulSession("203.0.113.40");
    expect(other.user.id).toBe(member.user.id);
    await subscribe(member, "desk");
    await subscribe(other, "phone");
    const othersWorkspace = await openWorkspaceSocket(other);
    const yourWorkspace = await openWorkspaceSocket(member);

    const disconnected = await disconnect(member, { currentPassword: grace.password, pushSubscriptionEndpoint: endpointOf("desk") });
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);
    expect(disconnected.headers.get("Cache-Control")).toBe("no-store");
    const { profile } = (await disconnected.json()) as ProfileAnswer;
    expect(profile.memberful).toEqual({ membersOnly: true, connected: null });
    expect(await identities()).toEqual([]);
    expect(await othersWorkspace.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    await vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]), { timeout: 5_000 });
    expect(await signsIn(other)).toBe(false);
    expect(await signsIn(member)).toBe(true);
    expect(await yourWorkspace.answers()).toBe(true);
    expect(await subscriptions()).toEqual([{ user_id: member.user.id, endpoint: endpointOf("desk") }]);

    // Memberful signs her in no more, until she connects an account again, which she can.
    expect(locationOf(await signInWithMemberful())).toBe(backToSignIn("taken"));
    const again = await disconnect(member, { currentPassword: grace.password });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: MEMBERFUL_NOT_CONNECTED });
    await connectGrace(member);
    expect((await profileOf(member)).memberful).toEqual({ membersOnly: true, connected: GRACES });
    yourWorkspace.ws.close(1000);
  });

  it("asks for your password, counting it against the sign-in limit", async () => {
    const { member } = await setUpWithGrace();
    await connectGrace(member);
    // From an address connecting counted nothing against.
    const from = { ip: "203.0.113.50" };
    const without = await disconnect(member, {}, from);
    expect(without.status).toBe(422);
    expect(await without.json()).toEqual({ error: MEMBERFUL_DISCONNECT_PASSWORD_NEEDED });
    const wrong = await disconnect(member, { currentPassword: "wrong" }, from);
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toEqual({ error: CURRENT_PASSWORD_WRONG });
    for (let attempt = 2; attempt < 10; attempt++) expect((await disconnect(member, { currentPassword: "wrong" }, from)).status).toBe(422);

    const limited = await disconnect(member, { currentPassword: grace.password }, from);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: SIGN_IN_LIMITED });
    expect(await identities()).toHaveLength(1);
    expect((await disconnect(member, { currentPassword: grace.password }, { ip: "203.0.113.21" })).status).toBe(200);
    expect(await identities()).toEqual([]);
  });

  it("asks someone with a password but no email address to add one first, since signing in with a password takes one", async () => {
    await setUpWithMemberful({ membersOnly: false });
    const site = fakeMemberful();
    const session = await memberfulSessionOf({ ...katherine, id: "4243", fullName: "Dorothy Vaughan", email: null }, site);
    // Her first, where Memberful doesn't sign her in.
    expect((await saveProfile(session, { password: "a long enough password" }, {})).status).toBe(200);
    const refused = await disconnect(session, { currentPassword: "a long enough password" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: MEMBERFUL_DISCONNECT_WITHOUT_EMAIL });
    expect(await identities()).toEqual([{ issuer: SITE, subject: "4243", user_id: session.user.id }]);

    expect((await saveProfile(session, { emailAddress: "dorothy@example.com", currentPassword: "a long enough password" })).status).toBe(200);
    const disconnected = await disconnect(session, { currentPassword: "a long enough password" });
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);
    expect(await identities()).toEqual([]);
    expect((await signInWithPassword({ emailAddress: "dorothy@example.com", password: "a long enough password" })).status).toBe(201);
  });

  it("refuses someone without a password, whom Memberful signs in alone, until they have one to sign in with instead", async () => {
    await setUpWithMemberful({ membersOnly: false });
    fakeMemberful();
    const session = await memberfulSession();
    for (const body of [{}, { currentPassword: "a long enough password" }]) {
      const refused = await disconnect(session, body);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: MEMBERFUL_DISCONNECT_WITHOUT_PASSWORD });
    }
    expect(await identities()).toHaveLength(1);

    // A first password, set where Memberful doesn't sign them in, lets them disconnect it.
    expect((await saveProfile(session, { password: "a long enough password" }, {})).status).toBe(200);
    const disconnected = await disconnect(session, { currentPassword: "a long enough password" });
    expect(disconnected.status).toBe(200);
    // Nothing to show: Memberful isn't members only, and nothing is connected.
    expect(((await disconnected.json()) as ProfileAnswer).profile.memberful).toBeNull();
    expect(await identities()).toEqual([]);
    expect((await signInWithPassword({ emailAddress: katherine.email, password: "a long enough password" })).status).toBe(201);
  });

  it("answers 401 without a session, 403 to a guest or a deployment without the keys, and 404 while you haven't connected one", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const guest = await signIn("Visitor");
    const password = { currentPassword: grace.password };
    expect((await disconnect(null, password)).status).toBe(401);
    const unavailable = await disconnect(member, password, { keys: false });
    expect(unavailable.status).toBe(403);
    expect(await unavailable.json()).toEqual({ error: MEMBERFUL_SIGN_IN_PROBLEMS.unavailable });
    const guests = await disconnect(guest, password);
    expect(guests.status).toBe(403);
    expect(await guests.json()).toEqual({ error: "Guests can't disconnect Memberful" });
    for (const membersOnly of [null, false, true]) {
      if (membersOnly !== null) await turnMemberful(administrator, true, { membersOnly });
      const nothing = await disconnect(member, password);
      expect(nothing.status).toBe(404);
      expect(await nothing.json()).toEqual({ error: MEMBERFUL_NOT_CONNECTED });
    }
    const bad = await disconnect(member, { currentPassword: 42 } as unknown as MemberfulDisconnection);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "Current password must be text" });
  });

  it("changes nothing once the password it checked isn't yours anymore", async () => {
    const { member } = await setUpWithGrace();
    await connectGrace(member);
    const other = await memberfulSession("203.0.113.40");
    const credentials = await credentialsFor(member.cookie.split("=")[1]!, new Request(origin), env as unknown as Env);
    // As when a reset lands between the check and the change.
    const refused = await runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.disconnectMemberful(credentials!, SITE, "a digest from before", null));
    expect(refused).toBe("refused");
    expect(await identities()).toHaveLength(1);
    expect(await signsIn(other)).toBe(true);
    expect(await signsIn(member)).toBe(true);
  });
});

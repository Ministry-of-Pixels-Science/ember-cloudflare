import {
  JOINING_PROBLEMS,
  MAX_TURNSTILE_TOKEN_LENGTH,
  OPEN_WITH_MEMBERFUL,
  PASSWORD_TOO_SHORT,
  SIGN_UP_FULL,
  SIGN_UP_LIMITED,
  SIGN_UPS_PER_ADDRESS,
  SIGN_UPS_PER_HOUR,
  TURNSTILE_FAILED,
  type Account,
  type Bootstrap,
  type Directory,
  type Me,
  type NewWorkspace,
  type Sidebar,
  type WorkspaceServerFrame,
} from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { verifyPassword } from "../src/passwords";
import { PEOPLE_JOINED_SINCE } from "../src/workspace-store";
import { api, apiWith, builtPages, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, origin, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };

/** The keys of a deployment whose members may sign in with Memberful. */
const MEMBERFUL_KEYS = { MEMBERFUL_URL: "https://example.memberful.com/", MEMBERFUL_CLIENT_ID: "ember-client-id", MEMBERFUL_CLIENT_SECRET: "ember-client-secret" };
/** Turnstile's test keys: a site key whose check always passes, and a secret key, which this suite's fake siteverify takes. */
const TURNSTILE_KEYS = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
/** The token Turnstile's test site keys give the page. */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HOUR_MS = 60 * 60 * 1000;

/** Sets Ember up with Ada as its administrator, signed in, answering general, its first room, too. */
async function setUp(): Promise<Session & { general: NewWorkspace["room"] }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const { user, room } = (await response.json()) as NewWorkspace;
  return { user: shown(user), cookie: cookieOf(response), general: room };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Changes the workspace's settings as `session`, as Membership's switches do, on a deployment whose bindings differ from this suite's by `changes`. */
const change = (session: Session | null, settings: unknown, changes: Partial<Env> = {}) =>
  apiWith(changes, "/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify({ settings }) });

/** Switches `settings` as `administrator`, which has to work. */
async function turn(administrator: Session, settings: Record<string, boolean>, changes: Partial<Env> = {}): Promise<void> {
  const response = await change(administrator, settings, changes);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Sets Ember up with Open on, with Ada as its administrator. */
async function setUpOpen(): Promise<Session & { general: NewWorkspace["room"] }> {
  const administrator = await setUp();
  await turn(administrator, { openSignUp: true });
  return administrator;
}

/** The workspace as pages show a new one, but for `changes`. */
const account = (changes: Partial<Account> = {}): Account => ({
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
  ssoJoin: false,
  ssoSignIn: false,
  emailDomainSignUp: false,
  emailDomains: [],
  navigationIcons: {},
  huddles: false,
  huddleCameras: true,
  huddleScreens: true,
  ...changes,
});

const bootstrap = async (changes: Partial<Env> = {}) => (await (await apiWith(changes, "/api/bootstrap")).json()) as Bootstrap;

const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as unknown;

/** Stores `settings` as the account's, as if the switches had been left so, and starts the Workspace afresh to read them. */
async function storeSettings(settings: string): Promise<void> {
  await workspaceSql("UPDATE accounts SET settings = ?", settings);
  await evictDurableObject(workspaceStub());
}

const joinCode = async () => ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

/** A page as the browser asks for it, with the built app standing in, without following a redirect. */
const page = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}, changes: Partial<Env> = {}) =>
  apiWith({ ASSETS: builtPages, ...changes }, path, { redirect: "manual", ...init });

/** Where an answer sends the browser. */
const locationOf = (response: Response) => response.headers.get("Location");

/** Posts the join form for `code`. */
const joinWithLink = (code: string, form: unknown) =>
  api(`/api/join/${code}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify(form) });

/** Posts the open sign-up form, from a browser at `ip`, with `cookie` if given, to a Worker whose bindings differ from this suite's by `changes`. */
const signUp = (form: unknown, { ip = "203.0.113.9", cookie, changes = {} }: { ip?: string; cookie?: string; changes?: Partial<Env> } = {}) =>
  apiWith(changes, "/api/join", {
    method: "POST",
    headers: { "User-Agent": "Grace's laptop", "CF-Connecting-IP": ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof form === "string" ? form : JSON.stringify(form),
  });

/** Someone new to sign up as, the `n`th. */
const newcomer = (n: number) => ({ name: `Newcomer ${n}`, emailAddress: `newcomer${n}@example.com`, password: "a long enough password" });

/** Adds `n` people with the role `role`, 0 for a member and 2 for a bot, as if they had joined at `at`. */
async function joinedAt(at: number, n: number, role = 0): Promise<void> {
  const when = new Date(at).toISOString();
  for (let i = 0; i < n; i++) {
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", `joined-${role}-${at}-${i}`, `Person ${i}`, role, when, when);
  }
}

/** A request the fake siteverify was sent. */
interface SentToSiteverify {
  url: string;
  method: string;
  body: unknown;
}

/** Stands in for Turnstile's siteverify, answering `answer` to each check, and keeping what it's sent in `requests`. */
function fakeSiteverify(answer: () => Response | Promise<Response> = () => Response.json({ success: true })) {
  const requests: SentToSiteverify[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, body: await request.json() });
    return answer();
  });
  return requests;
}

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Ways to join", () => {
  it("starts with the join link on and Open off, before first run too", async () => {
    expect((await bootstrap()).account).toMatchObject({ joinLink: true, openSignUp: false });
    await setUp();
    expect((await bootstrap()).account).toEqual(account());
  });

  it("switches each for everyone as an administrator does, keeping the other settings", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    const opened = await change(administrator, { openSignUp: true });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ account: account({ openSignUp: true }) });
    expect(await storedSettings()).toEqual({ restrict_room_creation_to_administrators: false, open_sign_up: true });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: account({ openSignUp: true }) } satisfies WorkspaceServerFrame);

    const linkOff = await change(administrator, { joinLink: false });
    expect(await linkOff.json()).toEqual({ account: account({ openSignUp: true, joinLink: false }) });
    expect(await storedSettings()).toEqual({ restrict_room_creation_to_administrators: false, open_sign_up: true, join_link: false });
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "account.updated", account: account({ openSignUp: true, joinLink: false }) });
    expect((await bootstrap()).account).toEqual(account({ openSignUp: true, joinLink: false }));

    await turn(administrator, { openSignUp: false, joinLink: true });
    expect((await bootstrap()).account).toEqual(account());
    for (const socket of sockets) socket.ws.close(1000);
  });

  it("is an administrator's to switch", async () => {
    await setUp();
    const grace = await signIn("Grace");
    for (const settings of [{ openSignUp: true }, { joinLink: false }]) {
      expect((await change(grace, settings)).status, JSON.stringify(settings)).toBe(403);
      expect((await change(null, settings)).status, JSON.stringify(settings)).toBe(401);
    }
    expect((await bootstrap()).account).toEqual(account());
  });

  it.each([
    [{ joinLink: "false" }, "Join link must be true or false"],
    [{ openSignUp: 1 }, "Open must be true or false"],
  ])("refuses %o, changing nothing", async (settings, error) => {
    const administrator = await setUp();
    const response = await change(administrator, settings);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
    expect((await bootstrap()).account).toEqual(account());
  });

  it.each([
    ["no setting", "{}", true, false],
    ["both on", '{"join_link":true,"open_sign_up":true}', true, true],
    ["both off", '{"join_link":false,"open_sign_up":false}', false, false],
    ["null", '{"join_link":null,"open_sign_up":null}', false, false],
    ["blank text", '{"join_link":" ","open_sign_up":" "}', false, false],
    ["settings that don't parse", "not JSON", true, false],
  ])("reads %s, the join link on until one is stored", async (_, stored, joinLink, openSignUp) => {
    await setUp();
    await storeSettings(stored);
    expect((await bootstrap()).account).toMatchObject({ joinLink, openSignUp });
  });

  describe("with Memberful", () => {
    const membersOnly = { memberfulJoin: true, memberfulSignIn: true };

    it("won't turn Open on while Memberful is members only, or Members only on while Open is", async () => {
      const administrator = await setUp();
      await turn(administrator, { openSignUp: true });
      const memberful = await change(administrator, { memberfulSignIn: true }, MEMBERFUL_KEYS);
      expect(memberful.status).toBe(422);
      expect(await memberful.json()).toEqual({ error: OPEN_WITH_MEMBERFUL });
      // Nor both at once, from both off.
      await turn(administrator, { openSignUp: false });
      const both = await change(administrator, { openSignUp: true, memberfulSignIn: true }, MEMBERFUL_KEYS);
      expect(both.status).toBe(422);
      expect(await both.json()).toEqual({ error: OPEN_WITH_MEMBERFUL });
      expect((await bootstrap()).account).toEqual(account());

      await turn(administrator, { memberfulSignIn: true }, MEMBERFUL_KEYS);
      const open = await change(administrator, { openSignUp: true }, MEMBERFUL_KEYS);
      expect(open.status).toBe(422);
      expect(await open.json()).toEqual({ error: OPEN_WITH_MEMBERFUL });
      expect((await bootstrap()).account).toEqual(account(membersOnly));
    });

    it("keeps Memberful on beside Open and the join link, in any order, while it isn't members only", async () => {
      const administrator = await setUp();
      await turn(administrator, { openSignUp: true });
      await turn(administrator, { memberfulJoin: true }, MEMBERFUL_KEYS);
      expect((await bootstrap()).account).toEqual(account({ openSignUp: true, memberfulJoin: true }));
      await turn(administrator, { openSignUp: false, memberfulJoin: false }, MEMBERFUL_KEYS);
      await turn(administrator, { openSignUp: true, memberfulJoin: true }, MEMBERFUL_KEYS);
      expect((await bootstrap()).account).toEqual(account({ openSignUp: true, memberfulJoin: true }));
      // But Members only still waits for Open to be off.
      const membersOnlyToo = await change(administrator, { memberfulSignIn: true }, MEMBERFUL_KEYS);
      expect(membersOnlyToo.status).toBe(422);
      expect(await membersOnlyToo.json()).toEqual({ error: OPEN_WITH_MEMBERFUL });
    });

    it("trades one for the other in one change, Memberful staying on as Members only goes off", async () => {
      const administrator = await setUp();
      await turn(administrator, { openSignUp: true });
      await turn(administrator, { openSignUp: false, memberfulSignIn: true }, MEMBERFUL_KEYS);
      expect((await bootstrap()).account).toEqual(account(membersOnly));
      await turn(administrator, { openSignUp: true, memberfulSignIn: false }, MEMBERFUL_KEYS);
      expect((await bootstrap()).account).toEqual(account({ openSignUp: true, memberfulJoin: true }));
    });

    it.each([
      ["Members only", { memberfulSignIn: false }],
      ["Memberful", { memberfulJoin: false }],
    ])("lets everything else change while Open and Members only are both stored on, letting nobody sign up, until %s is turned off", async (_, off) => {
      const administrator = await setUp();
      await storeSettings('{"open_sign_up":true,"memberful_join":true,"memberful_sign_in":true}');
      await turn(administrator, { joinLink: false }, MEMBERFUL_KEYS);
      expect(locationOf(await page("/join"))).toBe(`${origin}/session/new?joining=closed`);
      expect((await signUp(grace)).status).toBe(403);

      await turn(administrator, off, MEMBERFUL_KEYS);
      expect((await page("/join")).status).toBe(200);
    });
  });
});

describe("Join link", () => {
  it("sends people to sign in while it's off, saying so, and refuses its form before it's read", async () => {
    const administrator = await setUp();
    const code = await joinCode();
    await turn(administrator, { joinLink: false });

    const off = await page(`/join/${code}`);
    expect(off.status).toBe(302);
    expect(locationOf(off)).toBe(`${origin}/session/new?joining=link_off`);
    const joined = await api(`/api/join/${code}`, { method: "POST", body: "not even JSON" });
    expect(joined.status).toBe(403);
    expect(await joined.json()).toEqual({ error: JOINING_PROBLEMS.link_off, redirect: "/session/new?joining=link_off" });
    expect(joined.headers.get("Set-Cookie")).toBeNull();
    // A code that isn't the join code is still nothing, and someone signed in still goes home.
    expect((await page("/join/AAAA-BBBB-CCCC")).status).toBe(404);
    expect((await joinWithLink("AAAA-BBBB-CCCC", grace)).status).toBe(404);
    expect(locationOf(await page(`/join/${code}`, { headers: as(administrator) }))).toBe(`${origin}/`);
    expect(await count("users")).toBe(1);
  });

  it("lets people in with the same link once it's on again", async () => {
    const administrator = await setUp();
    const code = await joinCode();
    await turn(administrator, { joinLink: false });
    await turn(administrator, { joinLink: true });
    expect(await joinCode()).toBe(code);
    expect((await page(`/join/${code}`)).status).toBe(200);
    expect((await joinWithLink(code, grace)).status).toBe(201);
  });

  it("refuses a join whose form arrives after the link is turned off", async () => {
    const administrator = await setUp();
    const code = await joinCode();
    // Someone who opened the link holds their form back until it's off.
    const form = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await turn(administrator, { joinLink: false });
          controller.enqueue(new TextEncoder().encode(JSON.stringify(grace)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await apiWith({}, `/api/join/${code}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" }, body: form });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: JOINING_PROBLEMS.link_off, redirect: "/session/new?joining=link_off" });
    expect(await count("users")).toBe(1);
  });

  it("still lets people in while Open is on too", async () => {
    await setUpOpen();
    expect((await joinWithLink(await joinCode(), grace)).status).toBe(201);
  });

  it("has no limit of its own, however many join in an hour", async () => {
    await setUpOpen();
    await joinedAt(Date.now() - 60_000, 60);
    expect((await joinWithLink(await joinCode(), grace)).status).toBe(201);
  });
});

describe("Sign up without a link", () => {
  describe("the page", () => {
    it("sends people to sign in, saying signing up is closed, until an administrator turns Open on, before first run too", async () => {
      const closed = `${origin}/session/new?joining=closed`;
      expect(locationOf(await page("/join"))).toBe(closed);
      const administrator = await setUp();
      const response = await page("/join");
      expect(response.status).toBe(302);
      expect(locationOf(response)).toBe(closed);

      await turn(administrator, { openSignUp: true });
      const open = await page("/join");
      expect(open.status).toBe(200);
      expect(await open.text()).toBe("page /");
      expect(open.headers.get("Cache-Control")).toBe("no-store");
      expect((await page("/join", { method: "HEAD" })).status).toBe(200);
    });

    it("sends someone signed in home", async () => {
      const administrator = await setUpOpen();
      const response = await page("/join", { headers: as(administrator) });
      expect(response.status).toBe(302);
      expect(locationOf(response)).toBe(`${origin}/`);
    });

    it("lets Turnstile's check load there alone, while the deployment has both its keys", async () => {
      await setUpOpen();
      const turnstile = "https://challenges.cloudflare.com";
      const policy = async (path: string, changes: Partial<Env>) => (await page(path, {}, changes)).headers.get("Content-Security-Policy")!;
      const signUpPolicy = await policy("/join", TURNSTILE_KEYS);
      expect(signUpPolicy).toMatch(new RegExp(`script-src 'self'[^;]* ${turnstile};`));
      expect(signUpPolicy).toContain(`; frame-src ${turnstile};`);
      for (const [path, changes] of [
        ["/join", {}],
        ["/join", { TURNSTILE_SITE_KEY: TURNSTILE_KEYS.TURNSTILE_SITE_KEY }],
        ["/session/new", TURNSTILE_KEYS],
        [`/join/${await joinCode()}`, TURNSTILE_KEYS],
        ["/", TURNSTILE_KEYS],
      ] as const) {
        expect(await policy(path, changes), path).not.toContain(turnstile);
      }
    });

    it("tells the app the site key to show the check with, while the deployment has both keys", async () => {
      expect((await bootstrap()).turnstileSiteKey).toBeNull();
      expect((await bootstrap(TURNSTILE_KEYS)).turnstileSiteKey).toBe(TURNSTILE_KEYS.TURNSTILE_SITE_KEY);
      expect((await bootstrap({ TURNSTILE_SITE_KEY: TURNSTILE_KEYS.TURNSTILE_SITE_KEY })).turnstileSiteKey).toBeNull();
      expect((await bootstrap({ ...TURNSTILE_KEYS, TURNSTILE_SECRET_KEY: " " })).turnstileSiteKey).toBeNull();
    });
  });

  describe("the form", () => {
    it("adds a member in every open room, but no closed one, signs them in, and tells everyone's workspace sockets", async () => {
      const administrator = await setUpOpen();
      const [design, leads] = [await createRoom("Design", { as: administrator }), await createRoom("Leads", { as: administrator, closedTo: [administrator.user.id] })];
      const workspace = await openWorkspaceSocket(administrator);

      const response = await signUp(grace);
      expect(response.status).toBe(201);
      const { user } = (await response.json()) as { user: Me };
      expect(user).toEqual({ id: expect.any(String), name: "Grace Hopper", administrator: false });
      expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/)]);
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      const [member] = (await workspaceSql("SELECT name, email_address, password_digest, role, status, guest FROM users WHERE id = ?", user.id)) as Array<Record<string, unknown>>;
      expect(member).toMatchObject({ name: "Grace Hopper", email_address: "grace@example.com", role: 0, status: 0, guest: 0 });
      expect(await verifyPassword(grace.password, member!.password_digest as string)).toBe(true);
      expect(await workspaceSql("SELECT ip_address, user_agent FROM sessions WHERE user_id = ?", user.id)).toEqual([{ ip_address: "203.0.113.9", user_agent: "Grace's laptop" }]);

      const cookie = cookieOf(response);
      expect(await (await api("/api/me", { headers: { Cookie: cookie } })).json()).toEqual({ user });
      const { rooms } = (await (await api("/api/sidebar", { headers: { Cookie: cookie } })).json()) as Sidebar;
      // And the DM that welcomes them, with the administrator, last.
      const welcome = rooms.find((room) => room.kind === "direct")!;
      expect(rooms.map((room) => room.id)).toEqual([administrator.general.id, expect.any(String), design.id, welcome.id]);
      expect(rooms.map((room) => room.id)).not.toContain(leads.id);

      const { users } = (await (await api("/api/users", { headers: as(administrator) })).json()) as Directory;
      expect(await workspace.next()).toEqual({ type: "user.updated", user: users.find((person) => person.id === user.id) });
      expect(await workspace.next()).toEqual({ type: "room.saved", room: expect.objectContaining({ id: welcome.id, kind: "direct" }) });
      workspace.ws.close(1000);
    });

    it("refuses it before it's read while Open is off, or Memberful is members only, sending them to sign in", async () => {
      const closed = { error: JOINING_PROBLEMS.closed, redirect: "/session/new?joining=closed" };
      for (const settings of [null, "{}", '{"open_sign_up":false}', '{"open_sign_up":true,"memberful_sign_in":true}']) {
        if (settings === "{}") await setUp();
        if (settings !== null) await storeSettings(settings);
        const response = await signUp("not even JSON");
        expect(response.status, String(settings)).toBe(403);
        expect(await response.json(), String(settings)).toEqual(closed);
        expect(response.headers.get("Set-Cookie")).toBeNull();
      }
      expect(await count("users")).toBe(1);
    });

    it("sends someone signed in home", async () => {
      const administrator = await setUpOpen();
      const response = await signUp(grace, { cookie: administrator.cookie });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "You're signed in already", redirect: "/" });
      expect(await count("users")).toBe(1);
    });

    it("sends someone whose email address has an account to sign in with it, creating nothing", async () => {
      await setUpOpen();
      const response = await signUp({ ...grace, emailAddress: ada.emailAddress });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "That email address has an account already", redirect: "/session/new?email_address=ada%40example.com" });
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(await count("users")).toBe(1);
      expect(await count("sessions")).toBe(1);
    });

    it("makes one account however many sign up with one address at once", async () => {
      await setUpOpen();
      const responses = await Promise.all(["Grace", "Katherine", "Dorothy"].map((name, n) => signUp({ ...grace, name }, { ip: `203.0.113.${n + 1}` })));
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
      expect(await workspaceSql("SELECT count(*) AS n FROM users WHERE email_address = ?", grace.emailAddress)).toEqual([{ n: 1 }]);
    });

    it.each([
      ["a password shorter than first run takes", { ...grace, password: "1234567" }, 422, { error: PASSWORD_TOO_SHORT, field: "password" }],
      ["no email address", { ...grace, emailAddress: undefined }, 400, { error: "Name, email address and password are required" }],
      ["a token longer than Turnstile gives", { ...grace, turnstileToken: "x".repeat(MAX_TURNSTILE_TOKEN_LENGTH + 1) }, 400, { error: "Turnstile's token must be at most 2048 characters" }],
      ["no body", null, 400, { error: "Expected a JSON object" }],
    ])("refuses %s, as the join link's form does, creating nothing", async (_, form, status, body) => {
      await setUpOpen();
      const response = await signUp(form);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(await count("users")).toBe(1);
    });

    it("refuses a post from another site", async () => {
      await setUpOpen();
      const response = await apiWith({}, "/api/join", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify(grace) });
      expect(response.status).toBe(422);
      expect(await count("users")).toBe(1);
    });
  });

  describe("its limits, while the deployment lacks Turnstile's keys", () => {
    it("lets an address sign up 5 times an hour, counting addresses with an account already, then answers 429 before the password is hashed", async () => {
      await setUpOpen();
      for (let n = 1; n <= 4; n++) expect((await signUp(newcomer(n))).status, `sign-up ${n}`).toBe(201);
      expect((await signUp({ ...grace, emailAddress: ada.emailAddress })).status).toBe(409);

      const limited = await signUp(newcomer(5));
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: SIGN_UP_LIMITED });
      expect(limited.headers.get("Set-Cookie")).toBeNull();
      // Even for an address that has an account, so nobody can learn whose do many at a time.
      expect((await signUp({ ...grace, emailAddress: ada.emailAddress })).status).toBe(429);
      expect(await count("users")).toBe(5);

      expect((await signUp(newcomer(5), { ip: "198.51.100.4" })).status).toBe(201);

      // An IPv6 address counts as its /64, whichever of its addresses signs up.
      for (let n = 6; n <= 10; n++) expect((await signUp(newcomer(n), { ip: `2001:db8:1:2::${n}` })).status, `sign-up ${n}`).toBe(201);
      expect((await signUp(newcomer(11), { ip: "2001:db8:1:2:ffff::1" })).status).toBe(429);
      expect((await signUp(newcomer(11), { ip: "2001:db8:1:3::1" })).status).toBe(201);
    });

    it("starts counting an address's sign-ups again an hour after its first", async () => {
      await setUpOpen();
      const start = Date.now();
      // The Workspace runs in this isolate, so it sees the faked clock too.
      vi.useFakeTimers({ toFake: ["Date"], now: start });
      expect((await signUp(newcomer(1))).status).toBe(201);
      vi.setSystemTime(start + HOUR_MS - 60_000);
      for (let n = 2; n <= 5; n++) expect((await signUp(newcomer(n))).status, `sign-up ${n}`).toBe(201);
      vi.setSystemTime(start + HOUR_MS - 1);
      expect((await signUp(newcomer(6))).status).toBe(429);
      vi.setSystemTime(start + HOUR_MS);
      expect((await signUp(newcomer(6))).status).toBe(201);
    });

    it("doesn't count a form refused before it's checked", async () => {
      await setUpOpen();
      for (let attempt = 1; attempt <= 6; attempt++) expect((await signUp({ ...grace, password: "short" })).status).toBe(422);
      expect((await signUp(grace)).status).toBe(201);
    });

    it("lets 50 people into the workspace in an hour, however they joined and wherever from, bots aside, then answers 429 until the hour has passed", async () => {
      await setUpOpen();
      // Ada and 47 others joined in the last hour, but the bots and those who joined earlier don't count.
      await joinedAt(Date.now() - 30 * 60_000, 47);
      await joinedAt(Date.now() - 60_000, 5, 2);
      await joinedAt(Date.now() - HOUR_MS - 60_000, 5);
      expect((await signUp(newcomer(1), { ip: "198.51.100.1" })).status).toBe(201);
      expect((await signUp(newcomer(2), { ip: "198.51.100.2" })).status).toBe(201);

      const full = await signUp(newcomer(3), { ip: "198.51.100.3" });
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({ error: SIGN_UP_FULL });
      // It counts the people kept, so a Workspace that starts afresh still knows.
      await evictDurableObject(workspaceStub());
      expect((await signUp(newcomer(3), { ip: "198.51.100.3" })).status).toBe(429);
      expect(await count("users")).toBe(1 + 47 + 5 + 5 + 2);

      await workspaceSql("UPDATE users SET created_at = ? WHERE id LIKE 'joined-0-%'", new Date(Date.now() - HOUR_MS - 60_000).toISOString());
      expect((await signUp(newcomer(3), { ip: "198.51.100.3" })).status).toBe(201);
    });

    it("counts the hour's new people through an index, reading no more of it than the limit", async () => {
      const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${PEOPLE_JOINED_SINCE}`, new Date().toISOString(), 2, 50)).map((row) => (row as { detail: string }).detail).join("; ");
      expect(plan).toMatch(/SEARCH users USING INDEX index_users_on_created_at_and_id \(created_at>\?\)/);
      expect(plan).not.toContain("SCAN users");
    });
  });

  describe("with Turnstile", () => {
    const withTurnstile = { changes: TURNSTILE_KEYS };

    it("asks siteverify whether the check passed, with the secret key, the token and where the form came from", async () => {
      await setUpOpen();
      const checks = fakeSiteverify();
      const response = await signUp({ ...grace, turnstileToken: TOKEN }, { ...withTurnstile, ip: "203.0.113.30" });
      expect(response.status).toBe(201);
      expect(checks).toEqual([{ url: SITEVERIFY, method: "POST", body: { secret: TURNSTILE_KEYS.TURNSTILE_SECRET_KEY, response: TOKEN, remoteip: "203.0.113.30" } }]);
    });

    it.each([
      ["no token", undefined, () => Response.json({ success: true }), 0],
      ["an empty token", "", () => Response.json({ success: true }), 0],
      ["a check that didn't pass", TOKEN, () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }), 1],
      ["a token used already", TOKEN, () => Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }), 1],
      ["siteverify failing", TOKEN, () => new Response("Bad gateway", { status: 502 }), 1],
      ["siteverify answering what isn't JSON", TOKEN, () => new Response("<html>", { status: 200 }), 1],
      ["siteverify out of reach", TOKEN, () => Promise.reject(new TypeError("Network connection lost")), 1],
    ])("refuses %s on the check's field, creating nothing", async (_, turnstileToken, answer, asked) => {
      await setUpOpen();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const checks = fakeSiteverify(answer);
      const response = await signUp({ ...grace, turnstileToken }, withTurnstile);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: TURNSTILE_FAILED, field: "turnstile" });
      expect(checks).toHaveLength(asked);
      expect(await count("users")).toBe(1);
    });

    it("lifts the limits it stands in for, however many sign up from an address, or join the workspace, in an hour", async () => {
      await setUpOpen();
      fakeSiteverify();
      for (let n = 1; n <= SIGN_UPS_PER_ADDRESS + 1; n++) expect((await signUp({ ...newcomer(n), turnstileToken: TOKEN }, withTurnstile)).status, `sign-up ${n}`).toBe(201);
      await joinedAt(Date.now() - 60_000, SIGN_UPS_PER_HOUR);
      expect((await signUp({ ...grace, turnstileToken: TOKEN }, withTurnstile)).status).toBe(201);
      // Without the keys, they hold again.
      const full = await signUp(newcomer(SIGN_UPS_PER_ADDRESS + 2), { ip: "198.51.100.4" });
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({ error: SIGN_UP_FULL });
    });

    it("isn't asked while the deployment lacks a key, or Open is off", async () => {
      const administrator = await setUpOpen();
      const checks = fakeSiteverify();
      expect((await signUp(grace, { changes: { TURNSTILE_SITE_KEY: TURNSTILE_KEYS.TURNSTILE_SITE_KEY } })).status).toBe(201);
      await turn(administrator, { openSignUp: false });
      expect((await signUp({ ...newcomer(1), turnstileToken: TOKEN }, withTurnstile)).status).toBe(403);
      expect(checks).toEqual([]);
    });
  });
});

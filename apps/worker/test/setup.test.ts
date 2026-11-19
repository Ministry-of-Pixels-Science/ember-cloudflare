import {
  EMAIL_ADDRESS_TOO_LONG,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USER_NAME_LENGTH,
  NAME_TOO_LONG,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  type Bootstrap,
  type NewWorkspace,
  type Room,
  type Sidebar,
} from "@ember/protocol";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { verifyPassword } from "../src/passwords";
import {
  NO_SETUP_PASSWORD,
  SETUP_LINK_NEEDED,
  SETUP_LINK_REFUSED,
  SETUP_PASSWORD_NEEDED,
  SETUP_PASSWORD_REFUSED,
  SETUP_TRIES_LIMITED,
} from "../src/setup";
import { api, apiWith, builtPages, cookieOf, freshDeploy, listedRoom, origin, SETUP_TOKEN, signIn, workspaceSql, workspaceStub } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "12345678" };

const setUp = (form: object, headers: Record<string, string> = {}) =>
  api("/api/first_run", { method: "POST", headers: { "User-Agent": "Ada's laptop", "CF-Connecting-IP": "203.0.113.7", ...headers }, body: JSON.stringify(form) });

const bootstrap = async (cookie?: string) => (await (await api("/api/bootstrap", { headers: cookie ? { Cookie: cookie } : {} })).json()) as Bootstrap;

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

/** The setup page as the browser asks for it, with the built app standing in. */
const page = (path: string, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith({ ASSETS: builtPages }, path, { redirect: "manual", ...init });

beforeEach(freshDeploy);

describe("Set up the workspace", () => {
  it("starts out waiting to be set up, with the setup page open to the first visitor", async () => {
    expect(await bootstrap()).toEqual({
      setup: "pending",
      // The suite's Worker has a setup token, so setup takes the link that carries it.
      setupAccess: "link",
      setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
      guestSignIn: true,
      signInWithMemberful: false,
      signInWithSso: null,
      turnstileSiteKey: null,
      passwordResetCodes: false,
      account: { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true },
      version: "0.5 beta 10",
      // The suite's key pair's public key, uncompressed, without padding.
      vapidPublicKey: "BEYXTBB5_jNhNzXDmx5KEU55Vbbd-u--Lk9rM5OFQvUkPIBwZJ9QzAq0zdEzFw6yTV8cTriz_qYBVicY02_VxTQ",
      // What the useragent gem reads without a user agent, which it takes as "Mozilla/4.0 (compatible)".
      platform: { ios: false, android: false, desktop: true, windows: false, chrome: false, firefox: false, safari: false, edge: false, browser: "Mozilla", operatingSystem: "" },
      user: null,
    });
    expect((await api("/api/bootstrap")).headers.get("Cache-Control")).toBe("no-store");

    const response = await page("/first_run");
    expect(response.status).toBe(200);
    // The app's own page, which shows the form at /first_run.
    expect(await response.text()).toBe("page /");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Rails' default, as any page has, since nothing private is on the way.
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("suggests the name and email address the deployment names in place of the defaults", async () => {
    const placeholders = async (changes: Partial<Env>) => ((await (await apiWith(changes, "/api/bootstrap")).json()) as Bootstrap).setupPlaceholders;
    expect(await placeholders({ EMBER_SETUP_NAME_PLACEHOLDER: "Grace Hopper", EMBER_SETUP_EMAIL_PLACEHOLDER: " grace@example.com " })).toEqual({
      name: "Grace Hopper",
      emailAddress: "grace@example.com",
    });
    // Each stands alone, and a blank one counts as unset.
    expect(await placeholders({ EMBER_SETUP_NAME_PLACEHOLDER: " ", EMBER_SETUP_EMAIL_PLACEHOLDER: "grace@example.com" })).toEqual({
      name: "Kevin Rose",
      emailAddress: "grace@example.com",
    });
  });

  it("creates the workspace, its administrator, general and random, and signs them in, opening general", async () => {
    const response = await setUp(ada);
    expect(response.status).toBe(201);
    const { user, room } = (await response.json()) as NewWorkspace;
    expect(user).toEqual({ id: expect.any(String), name: "Ada Lovelace", administrator: true });
    expect(room).toEqual({ id: expect.any(String), kind: "open", name: "general", icon: null });
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/)]);

    const [account] = (await workspaceSql("SELECT name, join_code, settings, singleton_guard FROM accounts")) as Array<Record<string, unknown>>;
    expect(account).toEqual({ name: "Ember", join_code: expect.stringMatching(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/), settings: '{"restrict_room_creation_to_administrators":false}', singleton_guard: 0 });

    const [administrator] = (await workspaceSql("SELECT id, name, email_address, password_digest, role, status, guest FROM users")) as Array<Record<string, unknown>>;
    expect(administrator).toMatchObject({ id: user.id, name: "Ada Lovelace", email_address: "ada@example.com", role: 1, status: 0, guest: 0 });
    expect(await verifyPassword("12345678", administrator!.password_digest as string)).toBe(true);

    const rooms = (await workspaceSql("SELECT id, kind, name, icon, creator_id FROM rooms ORDER BY created_at, id")) as Array<Room & { creator_id: string }>;
    expect(rooms).toEqual([
      { ...room, creator_id: user.id },
      { id: expect.any(String), kind: "open", name: "random", icon: null, creator_id: user.id },
    ]);
    const random = rooms[1]!;
    expect(await workspaceSql("SELECT room_id, user_id, involvement FROM memberships JOIN rooms ON rooms.id = room_id ORDER BY rooms.created_at, rooms.id")).toEqual([
      { room_id: room.id, user_id: user.id, involvement: "mentions" },
      { room_id: random.id, user_id: user.id, involvement: "mentions" },
    ]);
    expect(await workspaceSql("SELECT user_id, ip_address, user_agent FROM sessions")).toEqual([{ user_id: user.id, ip_address: "203.0.113.7", user_agent: "Ada's laptop" }]);

    const cookie = cookieOf(response);
    expect(await bootstrap(cookie)).toMatchObject({ setup: "complete", account: { name: "Ember" }, user });
    const sidebar = (await (await api("/api/sidebar", { headers: { Cookie: cookie } })).json()) as Sidebar;
    // general is the first room, so it has the welcome card.
    expect(sidebar.rooms).toEqual([listedRoom(room), listedRoom({ ...room, id: random.id, name: "random" })]);
    expect(sidebar.invitation?.roomId).toBe(room.id);
  });

  it.each(["", "short", "1234567", "éééé", "🔐🔐🔐🔐"])("refuses the password %j and creates nothing", async (password) => {
    const response = await setUp({ ...ada, password });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: PASSWORD_TOO_SHORT, field: "password" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    for (const table of ["accounts", "users", "rooms", "sessions"]) expect(await count(table), table).toBe(0);
  });

  it.each([MAX_PASSWORD_LENGTH + 1, 2 ** 19])("refuses a password of %i characters, which the form can't send, and creates nothing", async (length) => {
    const response = await setUp({ ...ada, password: "x".repeat(length) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: PASSWORD_TOO_LONG, field: "password" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    for (const table of ["accounts", "users", "rooms", "sessions"]) expect(await count(table), table).toBe(0);
  });

  it("takes a password as long as the form allows", async () => {
    const password = "x".repeat(MAX_PASSWORD_LENGTH);
    expect((await setUp({ ...ada, password })).status).toBe(201);
    const [administrator] = (await workspaceSql("SELECT password_digest FROM users")) as Array<{ password_digest: string }>;
    expect(await verifyPassword(password, administrator!.password_digest)).toBe(true);
  });

  it.each([
    ["a name", { ...ada, name: "x".repeat(MAX_USER_NAME_LENGTH + 1) }, { error: NAME_TOO_LONG, field: "name" }],
    ["an email address", { ...ada, emailAddress: `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH - 11)}@example.com` }, { error: EMAIL_ADDRESS_TOO_LONG, field: "emailAddress" }],
  ])("answers 422 to %s longer than Ember keeps, and creates nothing", async (_, form, body) => {
    const response = await setUp(form);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    for (const table of ["accounts", "users", "rooms", "sessions"]) expect(await count(table), table).toBe(0);
  });

  it("takes a name and an email address as long as Ember keeps", async () => {
    const name = "x".repeat(MAX_USER_NAME_LENGTH);
    const emailAddress = `${"x".repeat(MAX_EMAIL_ADDRESS_LENGTH - 12)}@example.com`;
    expect((await setUp({ ...ada, name, emailAddress })).status).toBe(201);
    expect(await workspaceSql("SELECT name, email_address FROM users")).toEqual([{ name, email_address: emailAddress }]);
  });

  it.each([
    ["a name", { ...ada, name: " " }],
    ["an email address", { ...ada, emailAddress: undefined }],
    ["a password", { ...ada, password: undefined }],
  ])("answers 400 without %s", async (_, form) => {
    const response = await setUp(form);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Name, email address and password are required" });
    expect(await count("accounts")).toBe(0);
  });

  it("refuses a post from another site", async () => {
    expect((await setUp(ada, { "Sec-Fetch-Site": "cross-site" })).status).toBe(422);
    expect(await count("accounts")).toBe(0);
  });

  it("happens once: then setup answers 409 and its pages send everyone home", async () => {
    expect((await setUp(ada)).status).toBe(201);

    const again = await setUp({ ...ada, name: "Mallory", emailAddress: "mallory@example.com" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Ember is already set up", redirect: "/" });
    expect(again.headers.get("Set-Cookie")).toBeNull();
    expect(await workspaceSql("SELECT name FROM users")).toEqual([{ name: "Ada Lovelace" }]);

    for (const path of ["/first_run", "/first_run.json"]) {
      const response = await page(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("Location"), path).toBe(`${origin}/`);
    }
  });

  it("creates one workspace however many people submit at once", async () => {
    const responses = await Promise.all(["Ada", "Grace", "Katherine", "Dorothy", "Mary"].map((name) => setUp({ ...ada, name, emailAddress: `${name}@example.com` })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(responses.filter((response) => response.status === 409).every((response) => !response.headers.has("Set-Cookie"))).toBe(true);
    expect(await count("accounts")).toBe(1);
    expect(await workspaceSql("SELECT count(*) AS n FROM users WHERE role = 1")).toEqual([{ n: 1 }]);
    expect(await count("rooms")).toBe(2);
  });

  it("puts everyone already here in general and random, and the administrator in every open room", async () => {
    const guest = await signIn("Grace");
    // An open room from before setup, which guests can make where they're let in.
    const before = await api("/api/rooms", { method: "POST", headers: { Cookie: guest.cookie }, body: JSON.stringify({ kind: "open", name: "Design" }) });
    expect(before.status).toBe(201);

    const { user } = (await (await setUp(ada)).json()) as NewWorkspace;
    const memberships = (await workspaceSql("SELECT rooms.name, memberships.user_id FROM memberships JOIN rooms ON rooms.id = memberships.room_id")) as Array<{ name: string; user_id: string }>;
    expect(memberships.map(({ name, user_id }) => `${name}: ${user_id}`).sort()).toEqual(
      ["Design", "general", "random"].flatMap((name) => [`${name}: ${guest.user.id}`, `${name}: ${user.id}`]).sort(),
    );
  });

  it("answers the form's page only as a page, and nothing else under /first_run", async () => {
    expect((await page("/first_run.json")).status).toBe(406);
    expect((await page("/first_run/new")).status).toBe(404);
    expect((await page("/first_run", { method: "POST", body: "user[name]=Ada" })).status).toBe(404);
    expect((await page("/first_run/access")).status).toBe(404);
    // Not setup's, nor a page of the app's: the built app answers it, with Campfire's 404 page.
    expect(await (await page("/first_runs")).text()).toBe("page /first_runs");
  });
});

/** The setup password these tests give a deployment, as Deploy to Cloudflare's form asks the deployer to make one up. */
const SETUP_PASSWORD = "correct horse battery staple";

/** A setup password as the page sends it, percent-encoded, since a header can't hold every character a password can. */
const encoded = (password: string) => encodeURIComponent(password);

/** A post to setup as the Set up Ember page sends it, to a Worker with the given setup secrets in place of the suite's. */
interface SetupPost {
  /** The post's bearer token, or none. */
  token?: string;
  /** The IP address it comes from, as Cloudflare's `CF-Connecting-IP` says. */
  ip?: string;
  /** The Worker's EMBER_SETUP_TOKEN, or unset. */
  secret: string | undefined;
  /** The Worker's EMBER_SETUP_PASSWORD, or unset. */
  password?: string;
  body?: string;
}

/** A first-run post to `url`, as `SetupPost` describes it. */
function firstRunAt(url: string, { token, ip = "203.0.113.7", secret, password, body = JSON.stringify(ada) }: SetupPost) {
  const headers = new Headers({ "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "CF-Connecting-IP": ip });
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  const request = new Request<unknown, IncomingRequestCfProperties>(url, { method: "POST", headers, body });
  return worker.fetch(request, { ...(env as unknown as Env), EMBER_SETUP_TOKEN: secret, EMBER_SETUP_PASSWORD: password });
}

/** The same, to this suite's Worker, whose setup token is `SETUP_TOKEN` unless `secret` says otherwise. */
const firstRunWith = (options: Partial<SetupPost>) => firstRunAt(`${origin}/api/first_run`, { secret: SETUP_TOKEN, ...options });

/** What setting Ember up takes, as `/api/bootstrap` at `url` tells a Worker whose EMBER_SETUP_TOKEN is `secret` and EMBER_SETUP_PASSWORD `password`. */
async function setupAccessAt(url: string, secret: string | undefined, password?: string): Promise<Bootstrap["setupAccess"]> {
  const response = await worker.fetch(new Request<unknown, IncomingRequestCfProperties>(`${url}/api/bootstrap`), {
    ...(env as unknown as Env),
    EMBER_SETUP_TOKEN: secret,
    EMBER_SETUP_PASSWORD: password,
  });
  return ((await response.json()) as Bootstrap).setupAccess;
}

const nothingCreated = async () => {
  for (const table of ["accounts", "users", "rooms", "sessions"]) expect(await count(table), table).toBe(0);
};

describe("Installer-protected setup link", () => {
  it("sets Ember up only through the deploy's setup link: without its token the form is refused before it's read", async () => {
    expect(await setupAccessAt(origin, SETUP_TOKEN)).toBe("link");
    const refused = await firstRunWith({});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: SETUP_LINK_NEEDED });
    expect(refused.headers.get("Set-Cookie")).toBeNull();
    // Before the form is read: one that isn't even JSON is refused the same way, not as a bad request.
    const unread = await firstRunWith({ body: "not a form" });
    expect([unread.status, await unread.json()]).toEqual([403, { error: SETUP_LINK_NEEDED }]);
    await nothingCreated();

    const created = await firstRunWith({ token: SETUP_TOKEN });
    expect(created.status).toBe(201);
    expect(cookieOf(created)).toMatch(/^__Host-session_token=/);
  });

  it("refuses a token that isn't this deployment's, however close, and asks for the link given none", async () => {
    for (const token of [`${SETUP_TOKEN.slice(0, -1)}f`, SETUP_TOKEN.toUpperCase(), `${SETUP_TOKEN}0`, "0".repeat(64)]) {
      const response = await firstRunWith({ token });
      expect(response.status, token).toBe(403);
      expect(await response.json()).toEqual({ error: SETUP_LINK_REFUSED });
    }
    for (const token of ["", " "]) {
      const blank = await firstRunWith({ token });
      expect([blank.status, await blank.json()]).toEqual([403, { error: SETUP_LINK_NEEDED }]);
    }
    await nothingCreated();
  });

  it("ignores the spaces and line breaks around the deployment's token that pasting it can bring along", async () => {
    const secret = ` ${SETUP_TOKEN}\n`;
    expect(await setupAccessAt(origin, secret)).toBe("link");
    expect((await firstRunWith({ secret, token: SETUP_TOKEN })).status).toBe(201);
  });

  it("checks the link before whether Ember is set up, so without it setup says nothing more", async () => {
    expect((await setUp(ada)).status).toBe(201);
    expect((await firstRunWith({})).status).toBe(403);
    expect((await firstRunWith({ token: SETUP_TOKEN })).status).toBe(409);
  });

  it("is closed, and says so, while the deployment has neither a setup password nor a token, or only blank ones", async () => {
    for (const [secret, password] of [[undefined, undefined], ["", ""], [" \n", "  "]] as const) {
      const secrets = JSON.stringify([secret, password]);
      expect(await setupAccessAt(origin, secret, password), secrets).toBe("closed");
      const response = await firstRunWith({ secret, password, token: SETUP_TOKEN });
      expect([response.status, await response.json()], secrets).toEqual([403, { error: NO_SETUP_PASSWORD }]);
    }
    await nothingCreated();
  });

  it("is open over loopback without either, where `wrangler dev` serves, and still asks for them there with one", async () => {
    const local = "http://localhost:8787";
    expect(await setupAccessAt(local, undefined)).toBe("open");
    expect(await setupAccessAt(local, SETUP_TOKEN)).toBe("link");
    expect(await setupAccessAt(local, undefined, SETUP_PASSWORD)).toBe("password");
    expect((await firstRunAt(`${local}/api/first_run`, { secret: SETUP_TOKEN })).status).toBe(403);
    expect((await firstRunAt(`${local}/api/first_run`, { secret: undefined, password: SETUP_PASSWORD })).status).toBe(403);
    const created = await firstRunAt(`${local}/api/first_run`, { secret: undefined });
    expect(created.status).toBe(201);
    expect(await workspaceSql("SELECT name FROM users")).toEqual([{ name: "Ada Lovelace" }]);
  });
});

/** A post to setup's `path` on a Worker with `SETUP_PASSWORD` as its setup password and no setup token, as Deploy to Cloudflare's form makes it. */
const withPassword = (path: string, options: Omit<Partial<SetupPost>, "secret"> = {}) => firstRunAt(`${origin}${path}`, { secret: undefined, password: SETUP_PASSWORD, ...options });

describe("Setup password from the deploy form", () => {
  afterEach(() => vi.useRealTimers());

  it("sets Ember up only with the setup password the deploy form asked for: without it the form is refused before it's read", async () => {
    expect(await setupAccessAt(origin, undefined, SETUP_PASSWORD)).toBe("password");
    for (const body of [JSON.stringify(ada), "not a form"]) {
      const refused = await withPassword("/api/first_run", { body });
      expect([refused.status, await refused.json()]).toEqual([403, { error: SETUP_PASSWORD_NEEDED }]);
      expect(refused.headers.get("Set-Cookie")).toBeNull();
    }
    await nothingCreated();

    const created = await withPassword("/api/first_run", { token: encoded(SETUP_PASSWORD) });
    expect(created.status).toBe(201);
    expect(cookieOf(created)).toMatch(/^__Host-session_token=/);
    expect(await workspaceSql("SELECT name, role FROM users")).toEqual([{ name: "Ada Lovelace", role: 1 }]);
  });

  it("says whether a setup password is right before the rest of the form is filled in, setting nothing up", async () => {
    const right = await withPassword("/api/first_run/check", { token: encoded(SETUP_PASSWORD) });
    expect(right.status).toBe(204);
    expect(right.headers.get("Set-Cookie")).toBeNull();
    const wrong = await withPassword("/api/first_run/check", { token: encoded("correct horse battery stapler") });
    expect([wrong.status, await wrong.json()]).toEqual([403, { error: SETUP_PASSWORD_REFUSED }]);
    const none = await withPassword("/api/first_run/check");
    expect([none.status, await none.json()]).toEqual([403, { error: SETUP_PASSWORD_NEEDED }]);
    await nothingCreated();

    // Open over loopback, with nothing to check.
    expect((await firstRunAt("http://localhost:8787/api/first_run/check", { secret: undefined })).status).toBe(204);
    // A setup link opens it as the form would.
    expect((await firstRunAt(`${origin}/api/first_run/check`, { secret: SETUP_TOKEN, token: SETUP_TOKEN })).status).toBe(204);
    expect((await firstRunAt(`${origin}/api/first_run/check`, { secret: SETUP_TOKEN, token: "0".repeat(64) })).status).toBe(403);
  });

  it("checks the setup password before whether Ember is set up, then sends someone with it home", async () => {
    expect((await withPassword("/api/first_run", { token: encoded(SETUP_PASSWORD) })).status).toBe(201);
    for (const path of ["/api/first_run/check", "/api/first_run"]) {
      expect((await withPassword(path, { token: encoded("not the password") })).status, path).toBe(403);
      const again = await withPassword(path, { token: encoded(SETUP_PASSWORD) });
      expect([again.status, await again.json()], path).toEqual([409, { error: "Ember is already set up", redirect: "/" }]);
    }
    expect(await count("users")).toBe(1);
  });

  it("refuses a password that isn't the deployment's, however close, and ignores the spaces around either", async () => {
    for (const password of [SETUP_PASSWORD.toUpperCase(), SETUP_PASSWORD.slice(0, -1), `${SETUP_PASSWORD}!`, SETUP_PASSWORD.replaceAll(" ", "")]) {
      const response = await withPassword("/api/first_run", { token: encoded(password) });
      expect([response.status, await response.json()], password).toEqual([403, { error: SETUP_PASSWORD_REFUSED }]);
    }
    await nothingCreated();

    const pasted = ` ${SETUP_PASSWORD}\n`;
    expect(await setupAccessAt(origin, undefined, pasted)).toBe("password");
    expect((await withPassword("/api/first_run", { password: pasted, token: encoded(`  ${SETUP_PASSWORD} `) })).status).toBe(201);
  });

  it("takes a setup password of any characters, as the page encodes it, or as it comes where it isn't encoded", async () => {
    const password = 'Pässwört "🔥" 100% / ü';
    expect((await withPassword("/api/first_run/check", { password, token: encoded(password) })).status).toBe(204);
    // Not percent-encoded, as a script might send it, whether or not it reads as encoded.
    for (const raw of ["100%sure, of course", "correct%20horse battery"]) {
      expect((await withPassword("/api/first_run/check", { password: raw, token: raw })).status, raw).toBe(204);
      expect((await withPassword("/api/first_run/check", { password: raw, token: `  ${raw}` })).status, raw).toBe(204);
      expect((await withPassword("/api/first_run/check", { password: raw, token: encoded(raw) })).status, raw).toBe(204);
    }
    expect((await withPassword("/api/first_run/check", { password: "100%sure, of course", token: "100%sure" })).status).toBe(403);
  });

  it("takes a setup password of any length, since Deploy to Cloudflare's form can't ask for a longer one", async () => {
    const short = "ü7";
    for (const secrets of [{ password: short }, { secret: short }, { secret: ` ${short} `, password: "" }]) {
      const given = { secret: undefined, ...secrets };
      expect(await setupAccessAt(origin, given.secret, given.password), JSON.stringify(secrets)).toBe("password");
      expect((await firstRunAt(`${origin}/api/first_run/check`, { ...given, token: encoded(short) })).status, JSON.stringify(secrets)).toBe(204);
    }
    expect((await withPassword("/api/first_run", { password: short, token: encoded("ü8") })).status).toBe(403);
    expect((await withPassword("/api/first_run", { password: short, token: encoded(short) })).status).toBe(201);
  });

  it("takes a setup token that isn't shaped like one as a setup password, as one typed into the dashboard may be", async () => {
    const secret = "Hunter2".repeat(2);
    expect(await setupAccessAt(origin, secret)).toBe("password");
    const refused = await firstRunWith({ secret, token: encoded("hunter2hunter2") });
    expect([refused.status, await refused.json()]).toEqual([403, { error: SETUP_PASSWORD_REFUSED }]);
    expect((await firstRunWith({ secret })).status).toBe(403);
    expect((await firstRunWith({ secret, token: encoded(secret) })).status).toBe(201);
  });

  it("takes the setup link's token too, where a deploy made one as well as the form's password", async () => {
    expect(await setupAccessAt(origin, SETUP_TOKEN, SETUP_PASSWORD)).toBe("password");
    const none = await firstRunWith({ password: SETUP_PASSWORD });
    expect([none.status, await none.json()]).toEqual([403, { error: SETUP_PASSWORD_NEEDED }]);
    expect((await firstRunAt(`${origin}/api/first_run/check`, { secret: SETUP_TOKEN, password: SETUP_PASSWORD, token: encoded(SETUP_PASSWORD) })).status).toBe(204);
    expect((await firstRunWith({ password: SETUP_PASSWORD, token: SETUP_TOKEN })).status).toBe(201);
  });

  it("allows 10 tries at the setup password every 10 minutes, from anywhere, counting tries sent at once", async () => {
    const start = Date.now();
    // The Workspace runs in this isolate, so it sees the faked clock too.
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const tries = await Promise.all(Array.from({ length: 12 }, (_, n) => withPassword("/api/first_run/check", { token: encoded(`wrong guess ${n}`), ip: `198.51.100.${n}` })));
    expect(tries.map((response) => response.status).sort()).toEqual([...Array(10).fill(403), 429, 429]);

    // Past the limit even the right password waits, and so does the form.
    for (const path of ["/api/first_run/check", "/api/first_run"]) {
      const limited = await withPassword(path, { token: encoded(SETUP_PASSWORD) });
      expect([limited.status, await limited.json()], path).toEqual([429, { error: SETUP_TRIES_LIMITED }]);
    }
    // Though not a setup link's token, which is too long to guess.
    expect((await firstRunAt(`${origin}/api/first_run/check`, { secret: SETUP_TOKEN, password: SETUP_PASSWORD, token: SETUP_TOKEN })).status).toBe(204);
    // Nor someone without a password, who isn't counted.
    expect((await withPassword("/api/first_run")).status).toBe(403);
    await nothingCreated();

    vi.setSystemTime(start + 10 * 60 * 1000 - 1);
    expect((await withPassword("/api/first_run/check", { token: encoded(SETUP_PASSWORD) })).status).toBe(429);
    vi.setSystemTime(start + 10 * 60 * 1000);
    expect((await withPassword("/api/first_run", { token: encoded(SETUP_PASSWORD) })).status).toBe(201);
  });
});

describe("Rooms from before memberships", () => {
  it("makes no second general or random where they were registered, and opens the old general", async () => {
    await workspaceStub().registerLegacyRooms(["general", "random"]);
    const response = await setUp(ada);
    expect(response.status).toBe(201);
    const { user, room } = (await response.json()) as NewWorkspace;
    expect(room).toEqual({ id: "general", kind: "open", name: "general", icon: null });
    expect(await workspaceSql("SELECT id, name, creator_id FROM rooms ORDER BY created_at, id")).toEqual([
      { id: "general", name: "general", creator_id: null },
      { id: "random", name: "random", creator_id: null },
    ]);
    expect(await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", user.id)).toEqual([{ room_id: "general" }, { room_id: "random" }]);

    // The old general, registered first, is the first room, as the old preview's is.
    const sidebar = (await (await api("/api/sidebar", { headers: { Cookie: cookieOf(response) } })).json()) as Sidebar;
    expect(sidebar.rooms.map(({ id }) => id)).toEqual(["general", "random"]);
    expect(sidebar.invitation?.roomId).toBe("general");
  });
});

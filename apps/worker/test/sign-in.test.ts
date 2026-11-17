import { CloseCode, MAX_EMAIL_ADDRESS_LENGTH, SIGN_IN_LIMITED, SIGN_IN_REJECTED, type Bootstrap, type NewWorkspace, type User } from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor } from "../src/auth";
import type { Env } from "../src/env";
import { hashPassword } from "../src/passwords";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import { api, apiWith, closeOf, connect, cookieOf, forwardUpgrade, freshDeploy, freshRoom, origin, pbkdf2Digest, post, settle, shown, signIn, upgrade, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const SIGN_IN_WINDOW_MS = 3 * 60 * 1000;

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** A sign-in with an email address and password, from `ip`. */
const signInWith = (body: unknown, { ip = "203.0.113.7", headers = {} }: { ip?: string; headers?: Record<string, string> } = {}) =>
  api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": ip, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Signs in as Ada from another browser, in a session of its own. */
async function signInAsAda(): Promise<Session> {
  const response = await signInWith({ emailAddress: ada.emailAddress, password: ada.password });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: User }).user), cookie: cookieOf(response) };
}

const sessionCount = async () => ((await workspaceSql("SELECT count(*) AS n FROM sessions")) as Array<{ n: number }>)[0]!.n;

const bootstrap = async (changes = {}) => (await (await apiWith(changes, "/api/bootstrap")).json()) as Bootstrap;

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sign in with email and password", () => {
  it("signs in an active person with their email address and password, in a session of its own", async () => {
    const { user: shownAs, cookie: firstRunCookie } = await setUp();
    const user = { ...shownAs, administrator: true };
    // Someone already signed in can sign in again.
    const response = await signInWith({ emailAddress: ada.emailAddress, password: ada.password }, { headers: { Cookie: firstRunCookie, "User-Agent": "Ada's phone" } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ user });
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/)]);

    const cookie = cookieOf(response);
    expect(cookie).not.toBe(firstRunCookie);
    expect(await workspaceSql("SELECT ip_address, user_agent FROM sessions WHERE user_agent = ?", "Ada's phone")).toEqual([{ ip_address: "203.0.113.7", user_agent: "Ada's phone" }]);
    expect(await sessionCount()).toBe(2);
    expect(await (await api("/api/me", { headers: { Cookie: cookie } })).json()).toEqual({ user });
    expect((await (await api("/api/bootstrap", { headers: { Cookie: cookie } })).json()) as Bootstrap).toMatchObject({ setup: "complete", user });
  });

  it.each([
    ["a wrong password", { emailAddress: ada.emailAddress, password: "difference engine" }],
    ["an unknown email address", { emailAddress: "grace@example.com", password: ada.password }],
    ["the address in other capitals", { emailAddress: "Ada@Example.com", password: ada.password }],
    ["the address with spaces around it", { emailAddress: ` ${ada.emailAddress} `, password: ada.password }],
    ["a blank password", { emailAddress: ada.emailAddress, password: "" }],
    ["a password longer than the form sends", { emailAddress: ada.emailAddress, password: ada.password.padEnd(73, "!") }],
    ["no password", { emailAddress: ada.emailAddress }],
    ["no email address", { password: ada.password }],
    ["a password that isn't text", { emailAddress: ada.emailAddress, password: 12345678 }],
    ["an empty body", {}],
    ["a null body", null],
    ["a number for a body", 42],
    ["a body that isn't JSON", "email_address=ada@example.com&password=analytical+engine"],
  ])("refuses %s with an alert", async (_, body) => {
    await setUp();
    const response = await signInWith(body);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: SIGN_IN_REJECTED });
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await sessionCount()).toBe(1);
  });

  it("doesn't look for an email address longer than any account's can be", async () => {
    await setUp();
    const lookups = await runInDurableObject(workspaceStub(), (workspace: Workspace) => vi.spyOn((workspace as unknown as { store: WorkspaceStore }).store, "passwordFor"));
    const addressOf = (length: number) => `${"a".repeat(length - "@example.com".length)}@example.com`;
    const tooLong = await signInWith({ emailAddress: addressOf(MAX_EMAIL_ADDRESS_LENGTH + 1), password: ada.password });
    expect(tooLong.status).toBe(401);
    expect(await tooLong.json()).toEqual({ error: SIGN_IN_REJECTED });
    expect(lookups).not.toHaveBeenCalled();
    // One as long as an account's can be is looked for, as any other is.
    expect((await signInWith({ emailAddress: addressOf(MAX_EMAIL_ADDRESS_LENGTH), password: ada.password })).status).toBe(401);
    expect(lookups).toHaveBeenCalledWith(addressOf(MAX_EMAIL_ADDRESS_LENGTH));
  });

  it.each([
    ["deactivated", 1],
    ["banned", 2],
  ])("doesn't sign in someone who has been %s", async (_, status) => {
    const { user } = await setUp();
    await workspaceSql("UPDATE users SET status = ? WHERE id = ?", status, user.id);
    expect((await signInWith({ emailAddress: ada.emailAddress, password: ada.password })).status).toBe(401);
  });

  it("never signs in someone without a password", async () => {
    await setUp();
    // Bots, and in Campfire people who joined with an empty password, have an address but no digest.
    const now = new Date().toISOString();
    await workspaceSql(
      "INSERT INTO users (id, name, email_address, password_digest, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "botbotbotbotbot1",
      "Bot",
      "bot@example.com",
      "",
      2,
      now,
      now,
    );
    expect((await signInWith({ emailAddress: "bot@example.com", password: "" })).status).toBe(401);
    expect((await signInWith({ emailAddress: "bot@example.com", password: "anything at all" })).status).toBe(401);
  });

  /** Grace, who joined with the password `digest` is the digest of. */
  async function graceWith(digest: string): Promise<string> {
    const now = new Date().toISOString();
    await workspaceSql(
      "INSERT INTO users (id, name, email_address, password_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "gracegracegrace1",
      "Grace Hopper",
      "grace@example.com",
      digest,
      now,
      now,
    );
    return now;
  }
  const graceStored = async () => ((await workspaceSql("SELECT password_digest, updated_at FROM users WHERE id = ?", "gracegracegrace1")) as Array<{ password_digest: string; updated_at: string }>)[0]!;

  it("replaces a digest from before scrypt as its password signs in, and only then", async () => {
    await setUp();
    const legacy = await pbkdf2Digest("compiler");
    const joined = await graceWith(legacy);
    // A wrong password changes nothing.
    expect((await signInWith({ emailAddress: "grace@example.com", password: "Compiler" })).status).toBe(401);
    expect((await graceStored()).password_digest).toBe(legacy);

    expect((await signInWith({ emailAddress: "grace@example.com", password: "compiler" })).status).toBe(201);
    const { password_digest: current, updated_at } = await graceStored();
    expect(current).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/);
    // Nothing Grace did, so nothing she'd see as a change.
    expect(updated_at).toBe(joined);

    // From then on the new digest is the one checked, and kept.
    expect((await signInWith({ emailAddress: "grace@example.com", password: "compiler" })).status).toBe(201);
    expect((await graceStored()).password_digest).toBe(current);
    expect((await signInWith({ emailAddress: "grace@example.com", password: "Compiler" })).status).toBe(401);
  });

  it("keeps a password reset while a sign-in with the old one was checked, and starts no session for it", async () => {
    await setUp();
    const legacy = await pbkdf2Digest("compiler");
    await graceWith(legacy);
    // The Workspace hears which digest the password was checked against, and a reset in between leaves another.
    await workspaceSql("UPDATE users SET password_digest = ? WHERE id = ?", "$reset$", "gracegracegrace1");
    const laptop = await credentialsFor("A".repeat(43), new Request(origin), env as unknown as Env);
    expect(await workspaceStub().startSession("gracegracegrace1", legacy, await hashPassword("compiler"), laptop.tokenDigest, laptop.client)).toBeNull();
    expect((await graceStored()).password_digest).toBe("$reset$");
    expect(await sessionCount()).toBe(1);
  });

  it("signs in two sign-ins with the password that arrive together while its digest is from before scrypt, and keeps one new digest", async () => {
    await setUp();
    await graceWith(await pbkdf2Digest("compiler"));
    // Both check the old digest; the first to finish replaces it, and the second finds it gone.
    const together = await Promise.all([1, 2].map(() => signInWith({ emailAddress: "grace@example.com", password: "compiler" })));
    expect(together.map((response) => response.status)).toEqual([201, 201]);
    expect((await graceStored()).password_digest).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/);
    expect(await sessionCount()).toBe(3);
    // A wrong password with it refuses as ever.
    expect((await signInWith({ emailAddress: "grace@example.com", password: "Compiler" })).status).toBe(401);
  });

  it("signs in someone the administrator didn't create, with the password they chose", async () => {
    await setUp();
    const now = new Date().toISOString();
    const digest = await hashPassword("compiler");
    await workspaceSql(
      "INSERT INTO users (id, name, email_address, password_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "gracegracegrace1",
      "Grace Hopper",
      "grace@example.com",
      digest,
      now,
      now,
    );
    const response = await signInWith({ emailAddress: "grace@example.com", password: "compiler" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ user: { id: "gracegracegrace1", name: "Grace Hopper", administrator: false } });
  });

  it("refuses everyone before Ember is set up", async () => {
    expect((await signInWith({ emailAddress: ada.emailAddress, password: ada.password })).status).toBe(401);
  });
});

describe("Sign-in attempt limit", () => {
  it("allows each IP 10 attempts, successful or not, then answers 429 without checking the password", async () => {
    await setUp();
    const wrong = { emailAddress: ada.emailAddress, password: "difference engine" };
    for (let attempt = 1; attempt <= 9; attempt++) expect((await signInWith(wrong)).status, `attempt ${attempt}`).toBe(401);
    await signInAsAda();

    const limited = await signInWith({ emailAddress: ada.emailAddress, password: ada.password });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: SIGN_IN_LIMITED });
    expect(limited.headers.has("Set-Cookie")).toBe(false);
    // So is an attempt that wouldn't get as far as a password.
    expect((await signInWith({})).status).toBe(429);

    expect((await signInWith({ emailAddress: ada.emailAddress, password: ada.password }, { ip: "198.51.100.4" })).status).toBe(201);
  });

  it("starts counting again 3 minutes after an IP's first attempt", async () => {
    await setUp();
    const start = Date.now();
    // The Workspace runs in this isolate, so it sees the faked clock too.
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const wrong = { emailAddress: ada.emailAddress, password: "difference engine" };
    expect((await signInWith(wrong)).status).toBe(401);
    vi.setSystemTime(start + SIGN_IN_WINDOW_MS - 60_000);
    for (let attempt = 2; attempt <= 10; attempt++) expect((await signInWith(wrong)).status, `attempt ${attempt}`).toBe(401);
    expect((await signInWith(wrong)).status).toBe(429);

    vi.setSystemTime(start + SIGN_IN_WINDOW_MS - 1);
    expect((await signInWith(wrong)).status).toBe(429);
    vi.setSystemTime(start + SIGN_IN_WINDOW_MS);
    expect((await signInWith({ emailAddress: ada.emailAddress, password: ada.password })).status).toBe(201);
  });

  it("doesn't count signing in with just a name", async () => {
    await setUp();
    for (let guest = 1; guest <= 10; guest++) {
      const response = await api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify({ name: `Guest ${guest}` }) });
      expect(response.status).toBe(201);
    }
    expect((await signInWith({ emailAddress: ada.emailAddress, password: ada.password })).status).toBe(201);
  });
});

describe("Sign out", () => {
  it("closes the sockets this browser opened, in every room, and leaves the person's other sessions connected", async () => {
    const laptop = await setUp();
    const lobby = await freshRoom("lobby");
    const annex = await freshRoom("annex");
    const phone = await signInAsAda();
    const grace = await signIn("Grace");

    const laptopInLobby = await connect(lobby, laptop);
    const laptopInAnnex = await connect(annex, laptop);
    const phoneInLobby = await connect(lobby, phone);
    const graceInLobby = await connect(lobby, grace);
    const graceInAnnex = await connect(annex, grace);
    const closes = [laptopInLobby, laptopInAnnex].map((tab) => closeOf(tab.ws));

    expect((await api("/api/session", { method: "DELETE", headers: { Cookie: laptop.cookie } })).status).toBe(204);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect((await api(`/api/rooms/${lobby}/socket`, upgrade(laptop.cookie))).status).toBe(401);
    expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]);

    // Ada's phone still has the lobby open, so she's still there; she has left the annex, once.
    expect(await graceInLobby.next("typing")).toEqual({ type: "typing", user: laptop.user, typing: false });
    expect(await graceInAnnex.next("presence.left")).toEqual({ type: "presence.left", userId: laptop.user.id });
    expect((await post(phoneInLobby, "Still here")).body).toBe("Still here");
    await settle(graceInLobby, graceInAnnex);
    expect(graceInLobby.log.filter((frame) => frame.type === "presence.left")).toEqual([]);
    expect(graceInAnnex.log.filter((frame) => frame.type === "presence.left")).toHaveLength(1);
  });

  it("turns away a socket the Workspace let through just before the session ended, which reaches the room after", async () => {
    const laptop = await setUp();
    const lobby = await freshRoom("lobby");
    const grace = await connect(lobby, "Grace");
    const tab = await connect(lobby, laptop);
    const closed = closeOf(tab.ws);
    // The Workspace lets another of the browser's tabs into the lobby, and the Worker is held up.
    const token = laptop.cookie.slice(laptop.cookie.indexOf("=") + 1);
    const access = await workspaceStub().roomAccess(await credentialsFor(token, new Request(origin), env as unknown as Env), lobby);

    expect((await api("/api/session", { method: "DELETE", headers: { Cookie: laptop.cookie } })).status).toBe(204);
    expect(await closed).toMatchObject({ code: CloseCode.Reconnect });
    const late = await forwardUpgrade(lobby, access!);
    expect(late.status).toBe(101);
    late.webSocket!.accept();
    expect(await closeOf(late.webSocket!)).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });

    // Nobody saw it arrive, and another of the person's sessions still gets in.
    await settle(grace);
    expect(grace.log.filter((frame) => frame.type === "presence.joined")).toEqual([{ type: "presence.joined", user: laptop.user }]);
    const phone = await signInAsAda();
    expect((await connect(lobby, phone)).me).toEqual(laptop.user);
  });

  it("still closes the session's sockets when the database saves the sign-out but its answer is lost", async () => {
    const laptop = await setUp();
    const lobby = await freshRoom("lobby");
    const closed = closeOf((await connect(lobby, laptop)).ws);
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const endSession = store.endSession.bind(store);
      store.endSession = async (...args) => {
        await endSession(...args);
        throw new Error("The database's answer was lost");
      };
    });

    expect((await api("/api/session", { method: "DELETE", headers: { Cookie: laptop.cookie } })).status).toBe(500);
    expect(await closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect((await api(`/api/rooms/${lobby}/socket`, upgrade(laptop.cookie))).status).toBe(401);
  });
});

describe("Sign in with email and password", () => {
  it("names no administrator to anyone signed out", async () => {
    await setUp();
    const shown = await bootstrap();
    expect(shown).not.toHaveProperty("helpContact");
    expect(JSON.stringify(shown)).not.toContain(ada.emailAddress);
  });
});

describe("Version", () => {
  it("is APP_VERSION, else GIT_REVISION, else the release, counting blank values as unset", async () => {
    expect((await bootstrap()).version).toBe("0.5 beta 7");
    expect((await bootstrap({ APP_VERSION: "1.2.3", GIT_REVISION: "abc123" })).version).toBe("1.2.3");
    expect((await bootstrap({ APP_VERSION: "", GIT_REVISION: "abc123" })).version).toBe("abc123");
    expect((await bootstrap({ APP_VERSION: " ", GIT_REVISION: " " })).version).toBe("0.5 beta 7");
  });
});

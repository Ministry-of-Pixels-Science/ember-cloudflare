import { CloseCode, type Me, type NewWorkspace } from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor, newSessionToken } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";
import { verifyPassword } from "../src/passwords";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import { api, closeOf, connect, cookieOf, freshDeploy, freshRoom, openWorkspaceSocket, origin, pushBrowser, settle, shown, upgrade, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };
const TOKEN = "0123456789abcdef".repeat(4);
const RESET = "Password updated; existing sessions and live connections for this user were revoked.";

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, setting a password of her own, signed in. */
async function joinAsGrace(): Promise<Session> {
  const joinCode = ((await workspaceSql("SELECT join_code FROM accounts")) as Array<{ join_code: string }>)[0]!.join_code;
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

let signIns = 0;

/** Signs in with an email address and password, each time from an IP address of its own, so no limit is reached. */
const signInWith = (emailAddress: string, password: string) =>
  api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": `203.0.113.${++signIns % 250}` }, body: JSON.stringify({ emailAddress, password }) });

/** Signs in as Grace, in a session of its own. */
async function signInAsGrace(password = grace.password): Promise<Session> {
  const response = await signInWith(grace.emailAddress, password);
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/**
 * A recovery request as reset-password.ts sends it: `token` as its bearer token, no cookie, and none of
 * the headers browsers add, to a Worker whose EMBER_RECOVERY_TOKEN is `secret`, or unset for null.
 */
function recover(body: unknown, { token = TOKEN, secret = TOKEN, method = "POST" }: { token?: string; secret?: string | null; method?: string } = {}) {
  const headers = new Headers(token ? { Authorization: `Bearer ${token}` } : {});
  const sent = method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  if (sent !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request<unknown, IncomingRequestCfProperties>(`${origin}/api/recovery/reset-password`, { method, headers, body: sent });
  return worker.fetch(request, { ...(env as unknown as Env), EMBER_RECOVERY_TOKEN: secret ?? undefined });
}

const storedPerson = async (emailAddress: string) =>
  ((await workspaceSql("SELECT id, password_digest, role, status, updated_at FROM users WHERE email_address = ?", emailAddress)) as Array<{
    id: string;
    password_digest: string | null;
    role: number;
    status: number;
    updated_at: string;
  }>)[0]!;

/** Saves a push subscription for `session` at Chrome's push service, at `/fcm/send/<label>`. */
async function subscribe(session: Session, label: string): Promise<void> {
  const { p256dh, auth } = await pushBrowser();
  const body = JSON.stringify({ endpoint: `https://fcm.googleapis.com/fcm/send/${label}`, p256dhKey: p256dh, authKey: auth });
  expect((await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: session.cookie }, body })).status).toBe(204);
}

const sessionsOf = async (userId: string) => ((await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId)) as Array<{ n: number }>)[0]!.n;

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Reset a password from the server", () => {
  it("gives someone a new password, as the script sends it, which signs them in where the old one doesn't", async () => {
    await setUp();
    await joinAsGrace();

    const response = await recover({ emailAddress: grace.emailAddress, password: "  new password  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: RESET });
    expect((await signInWith(grace.emailAddress, grace.password)).status).toBe(401);
    expect((await signInWith(grace.emailAddress, "new password")).status).toBe(401);
    expect((await signInWith(grace.emailAddress, "  new password  ")).status).toBe(201);
    expect((await signInWith(ada.emailAddress, ada.password)).status).toBe(201);
  });

  it("ends all their sessions and nobody else's, closing their sockets in every room and the workspace's", async () => {
    const administrator = await setUp();
    const laptop = await joinAsGrace();
    const phone = await signInAsGrace();
    const lobby = await freshRoom("lobby");
    const annex = await freshRoom("annex");
    const rooms = [await connect(lobby, laptop), await connect(annex, laptop), await connect(lobby, phone)];
    const workspaces = [await openWorkspaceSocket(laptop), await openWorkspaceSocket(phone)];
    const adaInLobby = await connect(lobby, administrator);
    const adasWorkspace = await openWorkspaceSocket(administrator);
    const closes = [...rooms.map((tab) => closeOf(tab.ws)), ...workspaces.map((tab) => tab.closed)];

    expect((await recover({ emailAddress: grace.emailAddress, password: "new password" })).status).toBe(200);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    // Rooms she has no tab in hear too, after hers have closed, and then nothing waits to be told again.
    await vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]), { timeout: 5_000 });
    for (const { cookie } of [laptop, phone]) {
      expect((await api("/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await api(`/api/rooms/${lobby}/socket`, upgrade(cookie))).status).toBe(401);
    }
    expect(await sessionsOf(laptop.user.id)).toBe(0);

    // Ada is still signed in and connected.
    expect(await sessionsOf(administrator.user.id)).toBe(1);
    expect((await api("/api/me", { headers: { Cookie: administrator.cookie } })).status).toBe(200);
    await settle(adaInLobby);
    expect(await adasWorkspace.answers()).toBe(true);
    // And Grace gets back in with her new password.
    expect((await connect(lobby, await signInAsGrace("new password"))).me).toEqual(laptop.user);
  });

  it("forgets their push subscriptions and nobody else's, so a browser no longer signed in as them gets none of their pushes", async () => {
    const administrator = await setUp();
    const laptop = await joinAsGrace();
    const phone = await signInAsGrace();
    for (const [session, label] of [[laptop, "laptop"], [phone, "phone"], [administrator, "ada"]] as const) await subscribe(session, label);

    expect((await recover({ emailAddress: grace.emailAddress, password: "new password" })).status).toBe(200);
    expect(await workspaceSql("SELECT user_id, endpoint FROM push_subscriptions")).toEqual([{ user_id: administrator.user.id, endpoint: "https://fcm.googleapis.com/fcm/send/ada" }]);
  });

  it("queues closing each ended session's sockets in each of their rooms, so a delivery tried again later spares a session begun since", async () => {
    await setUp();
    const laptop = await joinAsGrace();
    await signInAsGrace();
    await freshRoom("lobby");
    const later = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const sessions = (await workspaceSql("SELECT id FROM sessions WHERE user_id = ?", laptop.user.id)) as Array<{ id: string }>;
    const rooms = (await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ?", laptop.user.id)) as Array<{ room_id: string }>;
    expect(sessions).toHaveLength(2);
    // general, random, the lobby, and the DM that welcomed her as she joined.
    expect(rooms).toHaveLength(4);

    const queued = await runInDurableObject(workspaceStub(), (workspace: Workspace) =>
      (workspace as unknown as { store: WorkspaceStore }).store.resetPassword(laptop.user.id, "digest", CloseCode.Reconnect, later, new Date().toISOString()),
    );
    expect(queued).toBe(true);
    const expected = rooms.flatMap(({ room_id }) => sessions.map(({ id }) => ({ room_id, tag: `s:${id}`, code: CloseCode.Reconnect, due_at: later })));
    const byRoomAndTag = (a: { room_id: string; tag: string }, b: { room_id: string; tag: string }) => a.room_id.localeCompare(b.room_id) || a.tag.localeCompare(b.tag);
    expect(((await workspaceSql("SELECT room_id, tag, code, due_at FROM pending_revocations")) as typeof expected).sort(byRoomAndTag)).toEqual(expected.sort(byRoomAndTag));
    expect(await sessionsOf(laptop.user.id)).toBe(0);
  });

  it("keeps their role and status, so an administrator stays one and a banned person stays banned, and records when", async () => {
    await setUp();
    const member = await joinAsGrace();
    await workspaceSql("UPDATE users SET status = 2, updated_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", member.user.id);

    expect((await recover({ emailAddress: grace.emailAddress, password: "new password" })).status).toBe(200);
    const banned = await storedPerson(grace.emailAddress);
    expect(banned).toMatchObject({ role: 0, status: 2 });
    expect(banned.updated_at > "2026-01-01T00:00:00.000Z").toBe(true);
    expect(await verifyPassword("new password", banned.password_digest!)).toBe(true);
    expect((await signInWith(grace.emailAddress, "new password")).status).toBe(401);

    expect((await recover({ emailAddress: ada.emailAddress, password: "difference engine" })).status).toBe(200);
    const response = await signInWith(ada.emailAddress, "difference engine");
    expect(response.status).toBe(201);
    expect(((await response.json()) as { user: Me }).user.administrator).toBe(true);
  });

  it("finds people only by their exact email address, and refuses bots, changing nobody", async () => {
    await setUp();
    await joinAsGrace();
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, email_address, role, created_at, updated_at) VALUES ('robot', 'Build Bot', 'bot@example.com', 2, ?, ?)", now, now);

    for (const emailAddress of ["Grace@example.com", " grace@example.com", "nobody@example.com"]) {
      const response = await recover({ emailAddress, password: "new password" });
      expect(response.status, emailAddress).toBe(404);
      expect(await response.json()).toEqual({ error: "no user has that email address" });
    }
    const bot = await recover({ emailAddress: "bot@example.com", password: "new password" });
    expect(bot.status).toBe(422);
    expect(await bot.json()).toEqual({ error: "bots cannot sign in with a password" });
    expect((await storedPerson("bot@example.com")).password_digest).toBeNull();
    expect((await signInWith(grace.emailAddress, grace.password)).status).toBe(201);
  });

  it("takes 8 to 72 characters, as sign-in does, counting an emoji as one character for the least", async () => {
    await setUp();
    await joinAsGrace();
    for (const password of ["12345678", "🔐".repeat(8), "x".repeat(72)]) {
      expect((await recover({ emailAddress: grace.emailAddress, password })).status, password).toBe(200);
      expect((await signInWith(grace.emailAddress, password)).status, password).toBe(201);
    }
  });

  it.each([
    ["shorter than 8 characters", "1234567", "password must contain at least 8 characters"],
    ["of 8 bytes but 4 characters", "éééé", "password must contain at least 8 characters"],
    ["longer than sign-in takes", "x".repeat(73), "password must contain at most 72 characters"],
  ])("refuses a password %s before looking for anyone", async (_, password, error) => {
    await setUp();
    const response = await recover({ emailAddress: "nobody@example.com", password });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
  });

  it.each([
    ["isn't JSON", "{", "Expected a JSON object"],
    ["has no email address", { password: "new password" }, "Email address and password are required"],
    ["has no password", { emailAddress: "grace@example.com" }, "Email address and password are required"],
  ])("answers 400 to a body that %s", async (_, body, error) => {
    await setUp();
    const response = await recover(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  it("answers 404, as an address the API doesn't have, while EMBER_RECOVERY_TOKEN is unset, and without its token", async () => {
    await setUp();
    await joinAsGrace();
    const body = { emailAddress: grace.emailAddress, password: "new password" };
    const answers = [
      await recover(body, { secret: null }),
      await recover(body, { token: "" }),
      await recover(body, { token: TOKEN.toUpperCase() }),
      await recover(body, { token: `${TOKEN}0` }),
      await recover(body, { token: "f".repeat(64) }),
      await recover(body, { method: "GET" }),
      await recover(body, { method: "PUT" }),
    ];
    for (const response of answers) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
    expect((await signInWith(grace.emailAddress, grace.password)).status).toBe(201);
  });

  it("refuses everyone while EMBER_RECOVERY_TOKEN can't be a token, saying so in the log but never what it is", async () => {
    await setUp();
    await joinAsGrace();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const secret of ["", "not a token", TOKEN.toUpperCase(), `${TOKEN} ${TOKEN}`]) {
      const response = await recover({ emailAddress: grace.emailAddress, password: "new password" }, { token: secret, secret });
      expect(response.status, JSON.stringify(secret)).toBe(404);
    }
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("EMBER_RECOVERY_TOKEN must be 64 lowercase hex characters"));
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/not a token|0123456789ABCDEF/);
    expect((await signInWith(grace.emailAddress, grace.password)).status).toBe(201);
  });

  it("ignores the spaces and line breaks around EMBER_RECOVERY_TOKEN that pasting it can bring along", async () => {
    await setUp();
    await joinAsGrace();
    expect((await recover({ emailAddress: grace.emailAddress, password: "new password" }, { secret: ` ${TOKEN}\n` })).status).toBe(200);
    expect((await signInWith(grace.emailAddress, "new password")).status).toBe(201);
  });

  it("turns away a sign-in that checked the old password before the reset", async () => {
    await setUp();
    const member = await joinAsGrace();
    const found = await workspaceStub().beginSignIn("203.0.113.251", grace.emailAddress);
    if (!found || found === "limited") throw new Error("Grace wasn't found");

    expect((await recover({ emailAddress: grace.emailAddress, password: "new password" })).status).toBe(200);
    const laptop = await credentialsFor(newSessionToken(), new Request(origin), env as unknown as Env);
    expect(await workspaceStub().startSession(member.user.id, found.passwordDigest, null, laptop.tokenDigest, laptop.client)).toBeNull();
    expect(await sessionsOf(member.user.id)).toBe(0);
  });

  it("still closes their sockets when the database saves the reset but its answer is lost, and logs neither secret", async () => {
    await setUp();
    const member = await joinAsGrace();
    const lobby = await freshRoom("lobby");
    const closes = [closeOf((await connect(lobby, member)).ws), (await openWorkspaceSocket(member)).closed];
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const resetPassword = store.resetPassword.bind(store);
      store.resetPassword = async (...args) => {
        await resetPassword(...args);
        throw new Error("The database's answer was lost");
      };
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await recover({ emailAddress: grace.emailAddress, password: "new password" });
    expect(response.status).toBe(500);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Reconnect });
    expect((await api(`/api/rooms/${lobby}/socket`, upgrade(member.cookie))).status).toBe(401);
    expect(logged).toHaveBeenCalledWith("POST /api/recovery/reset-password failed:", "500 Internal Server Error");
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(new RegExp(`${TOKEN}|new password`));
  });
});

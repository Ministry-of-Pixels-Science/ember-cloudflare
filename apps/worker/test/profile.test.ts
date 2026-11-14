import {
  CloseCode,
  CURRENT_PASSWORD_NEEDED,
  CURRENT_PASSWORD_WRONG,
  MAX_BIO_LENGTH,
  PASSWORD_TOO_SHORT,
  SIGN_IN_LIMITED,
  type Directory,
  type DirectoryUser,
  type NewWorkspace,
  type Profile,
  type ProfileAnswer,
  type UserId,
} from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsOf } from "../src/auth";
import type { Env } from "../src/env";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import {
  api,
  closeOf,
  connect,
  cookieOf,
  freshDeploy,
  freshRoom,
  openWorkspaceSocket,
  origin,
  pushBrowser,
  settle,
  shown,
  signIn,
  upgrade,
  workspaceSql,
  workspaceStub,
  type Session,
} from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

const profileOf = async (session: Session) => ((await (await api("/api/users/me/profile", { headers: as(session) })).json()) as ProfileAnswer).profile;

let addresses = 0;

/** An IP address of its own for each request, so that checking passwords reaches no limit unless a test means it to. */
const nextAddress = () => `203.0.113.${++addresses % 250}`;

const save = (session: Session | null, body: unknown, headers: Record<string, string> = {}) =>
  api("/api/users/me/profile", {
    method: "PATCH",
    headers: { "CF-Connecting-IP": nextAddress(), ...as(session), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Signs in with an email address and password, as the sign-in form does. */
const signInWith = (emailAddress: string, password: string, headers: Record<string, string> = { "CF-Connecting-IP": nextAddress() }) =>
  api("/api/session", { method: "POST", headers, body: JSON.stringify({ emailAddress, password }) });

/** Ada signs in again, as on another device. */
async function anotherSession(administrator: Session): Promise<Session> {
  const response = await signInWith(ada.emailAddress, ada.password);
  expect(response.status).toBe(201);
  return { user: administrator.user, cookie: cookieOf(response) };
}

const me = (session: Session) => api("/api/me", { headers: as(session) });

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

/** What your profile says of the avatar of someone who hasn't uploaded one: their initials, as the directory gives them. */
const initialsOf = async (session: Session) => ({ avatarUrl: (await listed(session, session.user.id)).avatarUrl, avatar: false });

interface StoredPerson {
  name: string;
  email_address: string | null;
  bio: string | null;
  password_digest: string | null;
  updated_at: string;
}

const stored = async (userId: UserId) =>
  ((await workspaceSql("SELECT name, email_address, bio, password_digest, updated_at FROM users WHERE id = ?", userId)) as StoredPerson[])[0]!;

const sessionsOf = async (userId: UserId) => ((await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId)) as Array<{ n: number }>)[0]!.n;

/** Where Chrome's push service takes the pushes of a subscription labelled `label`. */
const endpointOf = (label: string) => `https://fcm.googleapis.com/fcm/send/${label}`;

/** Saves a push subscription for `session`, at `endpointOf(label)`. */
async function subscribe(session: Session, label: string): Promise<void> {
  const { p256dh, auth } = await pushBrowser();
  const body = JSON.stringify({ endpoint: endpointOf(label), p256dhKey: p256dh, authKey: auth });
  expect((await api("/api/push-subscriptions", { method: "POST", headers: as(session), body })).status).toBe(204);
}

const subscriptions = () => workspaceSql("SELECT user_id, endpoint FROM push_subscriptions ORDER BY endpoint");

const LONG_AGO = "2026-01-01T00:00:00.000Z";

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Edit your profile", () => {
  it("shows you your name, email address and bio, or none for someone who signed in with just a name, and whether you have a password", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await workspaceSql("UPDATE users SET bio = ? WHERE id = ?", "Rear admiral", grace.user.id);

    const response = await api("/api/users/me/profile", { headers: as(administrator) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const profile = { name: "Ada Lovelace", emailAddress: "ada@example.com", bio: null, ...(await initialsOf(administrator)), password: true, membershipNeeded: false, memberful: null, assistant: null, apps: [], outsideAi: null };
    expect(await response.json()).toEqual({ profile, transferId: expect.any(String) } satisfies ProfileAnswer);
    expect(await profileOf(grace)).toEqual({ name: "Grace Hopper", emailAddress: null, bio: "Rear admiral", ...(await initialsOf(grace)), password: false, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null } satisfies Profile);
  });

  it("saves your name, email address and bio, answering your profile as it is then", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const changed = { name: "Grace Brewster Hopper", emailAddress: "grace@example.com", bio: "Wrote the first compiler" };

    const response = await save(grace, changed);
    expect(response.status).toBe(200);
    const profile: Profile = { ...changed, ...(await initialsOf(grace)), password: false, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null };
    expect(await response.json()).toEqual({ profile, transferId: expect.any(String) } satisfies ProfileAnswer);
    expect(await profileOf(grace)).toEqual(profile);
    expect(await (await me(grace)).json()).toEqual({ user: { id: grace.user.id, name: "Grace Brewster Hopper", administrator: false } });
    expect(await listed(administrator, grace.user.id)).toMatchObject({ name: "Grace Brewster Hopper", bio: "Wrote the first compiler" });
  });

  it("changes only what's sent, writing nothing when nothing differs", async () => {
    const grace = await signIn("Grace Hopper");
    await workspaceSql("UPDATE users SET bio = ?, updated_at = ? WHERE id = ?", "Rear admiral", LONG_AGO, grace.user.id);

    const initials = await initialsOf(grace);
    for (const body of [{}, { name: "Grace Hopper" }, { bio: "Rear admiral", password: "" }]) {
      const response = await save(grace, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(await response.json()).toEqual({ profile: { name: "Grace Hopper", emailAddress: null, bio: "Rear admiral", ...initials, password: false, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null }, transferId: expect.any(String) });
      expect((await stored(grace.user.id)).updated_at).toBe(LONG_AGO);
    }

    const answer = await (await save(grace, { bio: "Admiral" })).json();
    expect((await stored(grace.user.id)).updated_at > LONG_AGO).toBe(true);
    // The avatar's address changes with it, as it's versioned by when they last changed.
    expect(answer).toEqual({ profile: { name: "Grace Hopper", emailAddress: null, bio: "Admiral", ...(await initialsOf(grace)), password: false, membershipNeeded: true, memberful: null, assistant: null, apps: [], outsideAi: null }, transferId: expect.any(String) });
    expect((await initialsOf(grace)).avatarUrl).not.toBe(initials.avatarUrl);
  });

  it("takes the name as typed, even blank", async () => {
    const grace = await signIn("Grace Hopper");
    for (const name of ["  Amazing Grace ", ""]) {
      expect(await (await save(grace, { name })).json()).toMatchObject({ profile: { name } });
      expect((await stored(grace.user.id)).name).toBe(name);
    }
  });

  it("saves a blank email address or bio as none, so any number of people can be without one", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await save(grace, { emailAddress: "grace@example.com", bio: "Rear admiral" });

    for (const person of [administrator, grace]) {
      // Ada signs in with her email address, so taking it away takes her password.
      const currentPassword = person === administrator ? ada.password : undefined;
      const response = await save(person, { emailAddress: "", bio: "", currentPassword });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ profile: { emailAddress: null, bio: null } });
      expect(await stored(person.user.id)).toMatchObject({ email_address: null, bio: null });
    }
  });

  it("refuses an email address someone else has, saving nothing", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", LONG_AGO, grace.user.id);

    const response = await save(grace, { name: "Grace Brewster Hopper", emailAddress: ada.emailAddress });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "That email address has an account already" });
    expect(await stored(grace.user.id)).toMatchObject({ name: "Grace Hopper", email_address: null, updated_at: LONG_AGO });
    // Their own, and anyone else's that differs in case, which sign-in tells apart.
    expect((await save(administrator, { emailAddress: ada.emailAddress, bio: "Countess" })).status).toBe(200);
    expect((await save(grace, { emailAddress: "ADA@example.com" })).status).toBe(200);
  });

  it("signs you in with a new password, and not the old one", async () => {
    const administrator = await setUp();

    expect((await save(administrator, { password: "difference engine", currentPassword: ada.password })).status).toBe(200);
    expect((await signInWith(ada.emailAddress, ada.password)).status).toBe(401);
    expect((await signInWith(ada.emailAddress, "difference engine")).status).toBe(201);
  });

  it("asks for your current password to change your email address or password, refusing a missing or wrong one and saving nothing", async () => {
    const administrator = await setUp();
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", LONG_AGO, administrator.user.id);
    const before = await stored(administrator.user.id);

    const changes = [{ emailAddress: "countess@example.com" }, { emailAddress: "" }, { password: "difference engine" }, { name: "Ada King", password: "difference engine" }];
    const refusals = [
      [undefined, CURRENT_PASSWORD_NEEDED],
      ["", CURRENT_PASSWORD_NEEDED],
      ["difference engine", CURRENT_PASSWORD_WRONG],
      // One longer than the form takes is nobody's, as at sign-in.
      [`${ada.password}${"x".repeat(72)}`, CURRENT_PASSWORD_WRONG],
    ] as const;
    for (const change of changes) {
      for (const [currentPassword, error] of refusals) {
        const response = await save(administrator, { ...change, currentPassword });
        expect(response.status, JSON.stringify({ change, currentPassword })).toBe(422);
        expect(await response.json()).toEqual({ error });
      }
    }
    expect(await stored(administrator.user.id)).toEqual(before);

    // Your name and bio take none, nor does the email address you have.
    expect((await save(administrator, { name: "Ada King", emailAddress: ada.emailAddress, bio: "Countess", password: "" })).status).toBe(200);
    expect((await save(administrator, { emailAddress: "countess@example.com", currentPassword: ada.password })).status).toBe(200);
    expect(await stored(administrator.user.id)).toMatchObject({ name: "Ada King", email_address: "countess@example.com", bio: "Countess", password_digest: before.password_digest });
  });

  it("counts each current password it checks against sign-in's limit for your IP address, refusing even the right one past it", async () => {
    const administrator = await setUp();
    const from = { "CF-Connecting-IP": "198.51.100.7" };
    // What takes no password counts for nothing.
    for (let bio = 0; bio < 12; bio++) expect((await save(administrator, { bio: `Countess ${bio}` }, from)).status).toBe(200);
    for (let attempt = 0; attempt < 10; attempt++) expect((await save(administrator, { password: "difference engine", currentPassword: "wrong" }, from)).status).toBe(422);

    const response = await save(administrator, { password: "difference engine", currentPassword: ada.password }, from);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: SIGN_IN_LIMITED });
    expect((await signInWith(ada.emailAddress, ada.password, from)).status).toBe(429);
    // From anywhere else it's checked.
    expect((await save(administrator, { password: "difference engine", currentPassword: ada.password })).status).toBe(200);
  });

  it("ends your other sessions with a new password, closing their sockets in every room and the workspace's", async () => {
    const administrator = await setUp();
    const laptop = await anotherSession(administrator);
    const grace = await signIn("Grace Hopper");
    const lobby = await freshRoom("lobby");
    const annex = await freshRoom("annex");
    const laptopsWorkspace = await openWorkspaceSocket(laptop);
    const closes = [closeOf((await connect(lobby, laptop)).ws), closeOf((await connect(annex, laptop)).ws), laptopsWorkspace.closed];
    const yours = await connect(lobby, administrator);
    const yourWorkspace = await openWorkspaceSocket(administrator);
    const gracesWorkspace = await openWorkspaceSocket(grace);

    expect((await save(administrator, { password: "difference engine", currentPassword: ada.password })).status).toBe(200);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    // Rooms the laptop has no tab in hear too, and then nothing waits to be told again.
    await vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]), { timeout: 5_000 });
    expect((await me(laptop)).status).toBe(401);
    expect((await api(`/api/rooms/${lobby}/socket`, upgrade(laptop.cookie))).status).toBe(401);
    expect(await sessionsOf(administrator.user.id)).toBe(1);

    // This session is still signed in and connected, and so is everyone else's.
    expect((await me(administrator)).status).toBe(200);
    await settle(yours);
    expect(await yourWorkspace.answers()).toBe(true);
    expect(await gracesWorkspace.answers()).toBe(true);
    expect((await me(grace)).status).toBe(200);
  });

  it("forgets your other browsers' push subscriptions with a new password, keeping the one this browser names and everyone else's", async () => {
    const administrator = await setUp();
    const laptop = await anotherSession(administrator);
    const grace = await signIn("Grace Hopper");
    for (const [session, label] of [[administrator, "desk"], [laptop, "laptop"], [grace, "grace"]] as const) await subscribe(session, label);

    const changes = { password: "difference engine", currentPassword: ada.password, pushSubscriptionEndpoint: endpointOf("desk") };
    expect((await save(administrator, changes)).status).toBe(200);
    expect(await subscriptions()).toEqual([
      { user_id: administrator.user.id, endpoint: endpointOf("desk") },
      { user_id: grace.user.id, endpoint: endpointOf("grace") },
    ]);

    // A browser without one keeps none.
    expect((await save(administrator, { password: ada.password, currentPassword: "difference engine" })).status).toBe(200);
    expect(await subscriptions()).toEqual([{ user_id: grace.user.id, endpoint: endpointOf("grace") }]);
  });

  it("keeps your password, and every session, when the new one is blank", async () => {
    const administrator = await setUp();
    const laptop = await anotherSession(administrator);
    const { password_digest: digest } = await stored(administrator.user.id);

    expect((await save(administrator, { name: "Ada King", password: "" })).status).toBe(200);
    expect(await stored(administrator.user.id)).toMatchObject({ name: "Ada King", password_digest: digest });
    expect((await signInWith(ada.emailAddress, ada.password)).status).toBe(201);
    expect((await me(laptop)).status).toBe(200);
  });

  it("still closes your other sessions' sockets when the database saves the new password but its answer is lost", async () => {
    const administrator = await setUp();
    const laptop = await anotherSession(administrator);
    const lobby = await freshRoom("lobby");
    const closes = [closeOf((await connect(lobby, laptop)).ws), (await openWorkspaceSocket(laptop)).closed];
    const yourWorkspace = await openWorkspaceSocket(administrator);
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const changeProfile = store.changeProfile.bind(store);
      vi.spyOn(store, "changeProfile").mockImplementationOnce(async (...args) => {
        await changeProfile(...args);
        throw new Error("The database's answer was lost");
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await save(administrator, { password: "difference engine", currentPassword: ada.password })).status).toBe(500);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Reconnect });
    expect((await api(`/api/rooms/${lobby}/socket`, upgrade(laptop.cookie))).status).toBe(401);
    expect(await yourWorkspace.answers()).toBe(true);
  });

  it("saves nothing once a password reset ahead of it has ended the session, keeping the reset's password", async () => {
    const administrator = await setUp();
    const credentials = (await credentialsOf(new Request(origin, { headers: as(administrator) }), env as unknown as Env))!;
    const { password_digest: digest } = await stored(administrator.user.id);

    const answers = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      // The route checks the session before hashing a new password, and on D1 a reset can begin meanwhile.
      expect(await workspace.authenticate(credentials)).not.toBeNull();
      const reset = workspace.resetPassword(ada.emailAddress, "recovery digest");
      const saved = workspace.changeProfile(credentials, { name: "Mallory" }, "their own digest", digest, null, null);
      return Promise.all([reset, saved]);
    });
    expect(answers).toEqual(["reset", null]);
    expect(await stored(administrator.user.id)).toMatchObject({ name: "Ada Lovelace", password_digest: "recovery digest" });
  });

  it("refuses a change to what you sign in with whose current password was checked against a password replaced since, or none", async () => {
    const administrator = await setUp();
    const credentials = (await credentialsOf(new Request(origin, { headers: as(administrator) }), env as unknown as Env))!;
    const { password_digest: digest } = await stored(administrator.user.id);

    const answers = await runInDurableObject(workspaceStub(), (workspace: Workspace) =>
      // All three were checked against the password Ada had, which the first replaces.
      Promise.all([
        workspace.changeProfile(credentials, {}, "first digest", digest, null, null),
        workspace.changeProfile(credentials, {}, "second digest", digest, null, null),
        workspace.changeProfile(credentials, { emailAddress: "countess@example.com" }, null, digest, null, null),
        workspace.changeProfile(credentials, { emailAddress: "countess@example.com" }, null, null, null, null),
      ]),
    );
    expect(answers).toEqual([expect.objectContaining({ profile: expect.objectContaining({ password: true }) }), "password needed", "password needed", "password needed"]);
    expect(await stored(administrator.user.id)).toMatchObject({ email_address: ada.emailAddress, password_digest: "first digest" });
  });

  it("gives a password to someone who signed in with just a name, without asking for one, which signs them in once they have an email address and is asked for after", async () => {
    await setUp();
    const grace = await signIn("Grace Hopper");
    const answer = (await (await save(grace, { emailAddress: "grace@example.com", password: "compiler" })).json()) as ProfileAnswer;
    expect(answer.profile.password).toBe(true);
    expect((await signInWith("grace@example.com", "compiler")).status).toBe(201);

    expect(await (await save(grace, { emailAddress: "hopper@example.com" })).json()).toEqual({ error: CURRENT_PASSWORD_NEEDED });
    expect((await save(grace, { emailAddress: "hopper@example.com", currentPassword: "compiler" })).status).toBe(200);
  });

  it("tells everyone's workspace sockets of a new name or bio, as the directory then lists you", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", LONG_AGO, grace.user.id);
    const before = await listed(grace, grace.user.id);
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    await save(grace, { name: "Amazing Grace", bio: "Rear admiral" });
    const now = await listed(administrator, grace.user.id);
    expect(now).toMatchObject({ name: "Amazing Grace", bio: "Rear admiral" });
    // The initials changed, and so does the avatar's address.
    expect(now.avatarUrl).not.toBe(before.avatarUrl);
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "user.updated", user: now });
  });

  it("tells nobody of a new email address or password, which nobody else sees", async () => {
    const administrator = await setUp();
    const socket = await openWorkspaceSocket(administrator);

    await save(administrator, { emailAddress: "countess@example.com", password: "difference engine", currentPassword: ada.password });
    await save(administrator, { bio: "Countess" });
    // Only the bio was told.
    expect(await socket.next()).toMatchObject({ type: "user.updated", user: { bio: "Countess" } });
  });

  it.each([
    ["a body that isn't an object", "[]", "Expected a JSON object"],
    ["a name that isn't text", { name: 1 }, "Name must be text"],
    ["a password shorter than first run takes", { name: "Grace", password: "1234567" }, PASSWORD_TOO_SHORT],
    ["a password longer than sign-in takes", { name: "Grace", password: "x".repeat(73) }, "Password must be at most 72 characters."],
    ["a bio longer than the form takes", { bio: "x".repeat(MAX_BIO_LENGTH + 1) }, `Bio must be at most ${MAX_BIO_LENGTH} characters`],
  ])("refuses %s, saving nothing", async (_, body, error) => {
    const grace = await signIn("Grace Hopper");
    const before = await stored(grace.user.id);
    const response = await save(grace, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error });
    expect(await stored(grace.user.id)).toEqual(before);
  });

  it("answers 401 to anyone signed out, before anything they sent is checked", async () => {
    await setUp();
    expect((await api("/api/users/me/profile")).status).toBe(401);
    for (const body of [{ name: "Grace" }, "[]"]) expect((await save(null, body)).status).toBe(401);
  });

  it("refuses a save from another site", async () => {
    const grace = await signIn("Grace Hopper");
    expect((await save(grace, { name: "Mallory" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(422);
    expect((await stored(grace.user.id)).name).toBe("Grace Hopper");
  });

  it("answers only reading and saving it", async () => {
    const grace = await signIn("Grace Hopper");
    for (const method of ["PUT", "POST", "DELETE"]) {
      expect((await api("/api/users/me/profile", { method, headers: as(grace), body: JSON.stringify({ name: "Mallory" }) })).status).toBe(404);
    }
    expect((await api(`/api/users/${grace.user.id}/profile`, { headers: as(grace) })).status).toBe(404);
    expect((await stored(grace.user.id)).name).toBe("Grace Hopper");
  });
});

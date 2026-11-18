import {
  CloseCode,
  CURRENT_PASSWORD_WRONG,
  DELETED_PERSON_NAME,
  DELETION_NAME_NEEDED,
  DELETION_PASSWORD_NEEDED,
  ONLY_ADMINISTRATOR,
  SIGN_IN_LIMITED,
  type Directory,
  type DirectoryUser,
  type Me,
  type Message,
  type NewWorkspace,
  type RoomId,
  type UserId,
} from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsOf } from "../src/auth";
import type { Env } from "../src/env";
import { objectKey } from "../src/files/blobs";
import { BOOSTS_BY, RENAME_AUTHOR } from "../src/store";
import type { OutsideSender, Workspace } from "../src/workspace";
import {
  api,
  closeOf,
  connect,
  cookieOf,
  createRoom,
  direct,
  freshDeploy,
  freshRoom,
  openWorkspaceSocket,
  origin,
  post,
  reconnect,
  recordedImage,
  roomSql,
  roomStub,
  settle,
  shown,
  signIn,
  upgrade,
  upload,
  workspaceSql,
  workspaceStub,
  type Session,
  type Socket,
} from "./support";

// Delete my account, on your profile, which Apple asks of every app with accounts: everything removing
// someone does, then their messages and boosts in every room, and everything else of them but their row.

const bindings = env as unknown as Env;

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Someone joins with the join link, setting an email address and password, signed in. */
async function join(person: typeof grace): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(person) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

let addresses = 0;

/** An IP address of its own for each request, so that checking passwords reaches no limit unless a test means it to. */
const nextAddress = () => `203.0.113.${++addresses % 250}`;

/** Signs in with an email address and password, as the sign-in form does. */
const signInWith = ({ emailAddress, password }: typeof grace) =>
  api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": nextAddress() }, body: JSON.stringify({ emailAddress, password }) });

/** Grace signs in again, as on another device. */
async function signInAsGrace(): Promise<Session> {
  const response = await signInWith(grace);
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Delete my account, as `session`, saying they mean it with `body`. */
const deleteAccount = (session: Session | null, body: unknown, headers: Record<string, string> = { "CF-Connecting-IP": nextAddress() }) =>
  api("/api/users/me", { method: "DELETE", headers: { ...headers, ...(session ? { Cookie: session.cookie } : {}) }, body: JSON.stringify(body) });

/** Deletes Grace's account with her password, as she signs in with `session`. */
async function deleteGraces(session: Session): Promise<void> {
  const response = await deleteAccount(session, { currentPassword: grace.password });
  expect(response.status, await response.clone().text()).toBe(204);
}

const signedIn = async (session: Session) => (await api("/api/me", { headers: { Cookie: session.cookie } })).status === 200;

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

/** What's stored of someone. */
const stored = async (userId: UserId) =>
  ((await workspaceSql(
    `SELECT name, email_address, password_digest, username, bio, avatar_key, avatar_variant, role, status, deleted_at, updated_at FROM users WHERE id = ?`,
    userId,
  )) as Array<Record<string, string | number | null>>)[0]!;

/** How many rows of `table` are someone's. */
const rowsOf = async (table: string, userId: UserId) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`, userId)) as Array<{ n: number }>)[0]!.n;

/** The ids of the messages `userId` wrote in `room`, in the order they were written. */
const written = async (room: RoomId, userId: UserId) =>
  ((await roomSql(room, "SELECT id FROM messages WHERE room_id = ? AND creator_id = ? ORDER BY id", room, userId)) as Array<{ id: string }>).map(({ id }) => id);

/** The boosts in `room`, as who gave them on which message. */
const boostsIn = async (room: RoomId) => roomSql(room, "SELECT message_id, booster_id FROM boosts WHERE room_id = ? ORDER BY id", room);

/** Waits for the Workspace's outbox to have asked every room to delete what it was asked to. */
const purged = () => vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_purges")).toEqual([]), { timeout: 10_000 });

/** Boosts `message` with `content` as `client`, and waits for the room to confirm it. */
async function boost(client: Socket, message: Pick<Message, "id">, content: string): Promise<void> {
  client.send({ type: "boost.create", messageId: message.id, content });
  for (;;) {
    const { boost } = await client.next("boost.created");
    if (boost.messageId === message.id && boost.content === content) return;
  }
}

/** Replies in `parent`'s thread as `client`, and waits for the room to confirm it. */
async function reply(client: Socket, parent: Pick<Message, "id">, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Delete my account", () => {
  it("deletes your account once your password checks out, signing out this browser and every other session of yours, and closing your sockets everywhere", async () => {
    const administrator = await setUp();
    const laptop = await join(grace);
    const phone = await signInAsGrace();
    const lobby = await freshRoom("lobby");
    const { id: dm } = await direct(laptop, administrator);
    const closes = [
      closeOf((await connect(lobby, laptop)).ws),
      closeOf((await connect(dm, phone)).ws),
      (await openWorkspaceSocket(laptop)).closed,
      (await openWorkspaceSocket(phone)).closed,
    ];

    const response = await deleteAccount(laptop, { currentPassword: grace.password });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Revoked, reason: "Revoked" });
    for (const session of [laptop, phone]) {
      expect(await signedIn(session)).toBe(false);
      expect((await api(`/api/rooms/${dm}/socket`, upgrade(session.cookie))).status).toBe(401);
    }
    expect(await rowsOf("sessions", laptop.user.id)).toBe(0);
    expect((await signInWith(grace)).status).toBe(401);
    // Ada is still signed in.
    expect(await signedIn(administrator)).toBe(true);
  });

  it("leaves nothing of you but your row, deactivated and named Deleted person, without an email address, password, username, bio or avatar", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await workspaceSql(
      "UPDATE users SET username = 'amazing.grace', bio = 'Admiral', avatar_key = 'avatars/grace', avatar_variant = 'webp', assistant_model = 'some-model', role = 1 WHERE id = ?",
      member.user.id,
    );
    await bindings.FILES!.put("avatars/grace", recordedImage("moon-thumb.jpg"));

    await deleteGraces(member);
    const row = await stored(member.user.id);
    expect(row).toMatchObject({
      name: DELETED_PERSON_NAME,
      email_address: null,
      password_digest: null,
      username: null,
      bio: null,
      avatar_key: null,
      avatar_variant: null,
      role: 0,
      status: 1,
    });
    expect(row.deleted_at).toBe(row.updated_at);
    const listing = await listed(administrator, member.user.id);
    expect(listing).toMatchObject({ id: member.user.id, name: DELETED_PERSON_NAME, bio: null, role: "member", status: "deactivated" });
    expect(listing).not.toHaveProperty("username");
    // R2 deletes the avatar they had.
    await vi.waitFor(async () => expect(await bindings.FILES!.head("avatars/grace")).toBeNull(), { timeout: 5_000 });
    expect(await workspaceSql("SELECT object_key FROM pending_picture_deletions")).toEqual([]);
  });

  it("forgets everything else of yours: your rooms but DMs, starred rooms, searches, push subscriptions and accounts elsewhere", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const { id: dm } = await direct(member, administrator);
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO favorites (user_id, room_id, position) VALUES (?, ?, 0)", member.user.id, lobby);
    await workspaceSql("INSERT INTO recent_searches (user_id, search, position) VALUES (?, 'moth', 0)", member.user.id);
    await workspaceSql(
      "INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, created_at, updated_at) VALUES (?, 'https://push.example/grace', 'key', 'auth', ?, ?)",
      member.user.id,
      now,
      now,
    );
    await workspaceSql("INSERT INTO identities (issuer, subject, user_id, created_at, updated_at) VALUES ('https://fernwood.memberful.com', '42', ?, ?, ?)", member.user.id, now, now);

    await deleteGraces(member);
    for (const table of ["favorites", "recent_searches", "push_subscriptions", "identities", "sessions"]) expect(await rowsOf(table, member.user.id), table).toBe(0);
    // Their DMs keep them, so the people in them still see whom they were with.
    expect(((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ?", member.user.id)) as Array<{ room_id: string }>).map(({ room_id }) => room_id)).toEqual([dm]);
  });

  it("frees your email address, so it can join again as someone new", async () => {
    await setUp();
    const member = await join(grace);
    await deleteGraces(member);
    const again = await join(grace);
    expect(again.user.id).not.toBe(member.user.id);
    expect(await stored(again.user.id)).toMatchObject({ name: grace.name, email_address: grace.emailAddress, status: 0 });
  });

  it("frees your username, so someone else can take it", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const takeGrace = (session: Session) =>
      api("/api/users/me/profile", { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify({ username: "grace" }) });
    expect((await takeGrace(member)).status).toBe(200);
    expect((await takeGrace(administrator)).status).toBe(422);

    await deleteGraces(member);
    expect((await takeGrace(administrator)).status).toBe(200);
    expect(await listed(administrator, administrator.user.id)).toMatchObject({ username: "grace" });
  });

  it("refuses without your password, or with one that isn't yours, deleting nothing", async () => {
    await setUp();
    const member = await join(grace);
    for (const [body, error] of [
      [{}, DELETION_PASSWORD_NEEDED],
      [{ name: grace.name }, DELETION_PASSWORD_NEEDED],
      [{ currentPassword: "not hers" }, CURRENT_PASSWORD_WRONG],
      [{ currentPassword: "x".repeat(73) }, CURRENT_PASSWORD_WRONG],
    ] as const) {
      const response = await deleteAccount(member, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json()).toEqual({ error });
    }
    expect(await signedIn(member)).toBe(true);
    expect(await stored(member.user.id)).toMatchObject({ name: grace.name, status: 0, deleted_at: null });
  });

  it("counts each password it checks against sign-in's limit for your IP address, refusing even the right one past it", async () => {
    await setUp();
    const member = await join(grace);
    const from = { "CF-Connecting-IP": "198.51.100.7" };
    for (let attempt = 0; attempt < 10; attempt++) expect((await deleteAccount(member, { currentPassword: "wrong" }, from)).status).toBe(422);

    const response = await deleteAccount(member, { currentPassword: grace.password }, from);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: SIGN_IN_LIMITED });
    expect(await signedIn(member)).toBe(true);
    // From anywhere else it's checked.
    await deleteGraces(member);
  });

  it("takes the name of someone without a password, typed as their profile has it in any capitals, and nothing else", async () => {
    await setUp();
    const linus = await signIn("Linus Torvalds");
    for (const body of [{}, { name: "Linus" }, { currentPassword: "Linus Torvalds" }]) {
      const response = await deleteAccount(linus, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await response.json()).toEqual({ error: DELETION_NAME_NEEDED });
    }
    expect(await signedIn(linus)).toBe(true);

    expect((await deleteAccount(linus, { name: " linus torvalds" })).status).toBe(204);
    expect(await stored(linus.user.id)).toMatchObject({ name: DELETED_PERSON_NAME, status: 1 });
  });

  it("refuses the only administrator, who must make someone else one first, whatever they type", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    for (const body of [{ currentPassword: ada.password }, { currentPassword: "wrong" }, {}]) {
      const response = await deleteAccount(administrator, body);
      expect(response.status, JSON.stringify(body)).toBe(409);
      expect(await response.json()).toEqual({ error: ONLY_ADMINISTRATOR });
    }
    expect(await signedIn(administrator)).toBe(true);

    const promoted = await api(`/api/account/users/${member.user.id}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ role: "administrator" }) });
    expect(promoted.status).toBe(200);
    expect((await deleteAccount(administrator, { currentPassword: ada.password })).status).toBe(204);
    expect(await stored(administrator.user.id)).toMatchObject({ name: DELETED_PERSON_NAME, role: 0, status: 1 });
  });

  it("refuses without a session, and once your account is deleted", async () => {
    await setUp();
    const member = await join(grace);
    expect((await deleteAccount(null, { currentPassword: grace.password })).status).toBe(401);
    await deleteGraces(member);
    expect((await deleteAccount(member, { currentPassword: grace.password })).status).toBe(401);
  });

  it("refuses a deletion whose password was checked against one replaced since, or without one", async () => {
    await setUp();
    const member = await join(grace);
    const credentials = (await credentialsOf(new Request(origin, { headers: { Cookie: member.cookie } }), bindings))!;
    const [{ password_digest: digest }] = (await workspaceSql("SELECT password_digest FROM users WHERE id = ?", member.user.id)) as [{ password_digest: string }];

    await workspaceSql("UPDATE users SET password_digest = 'replaced' WHERE id = ?", member.user.id);
    const answers = await runInDurableObject(workspaceStub(), (workspace: Workspace) =>
      Promise.all([workspace.deleteAccount(credentials, digest, undefined), workspace.deleteAccount(credentials, null, grace.name)]),
    );
    expect(answers).toEqual(["password needed", "password needed"]);
    expect(await stored(member.user.id)).toMatchObject({ name: grace.name, status: 0 });
  });

  it("tells everyone's workspace sockets, as the directory then lists you, with an avatar at a new address", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await workspaceSql("UPDATE users SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", member.user.id);
    const before = await listed(administrator, member.user.id);
    const socket = await openWorkspaceSocket(administrator);

    await deleteGraces(member);
    const frame = await socket.next();
    expect(frame).toEqual({ type: "user.updated", user: await listed(administrator, member.user.id) });
    expect(frame).toMatchObject({ user: { name: DELETED_PERSON_NAME, status: "deactivated" } });
    expect((frame as { user: DirectoryUser }).user.avatarUrl).not.toBe(before.avatarUrl);
    expect((await api((frame as { user: DirectoryUser }).user.avatarUrl, { headers: { Cookie: administrator.cookie } })).status).toBe(200);
  });

  it("can't be banned, nor have a ban lifted, once deleted, so nothing brings it back", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await deleteGraces(member);
    for (const method of ["POST", "DELETE"]) {
      expect((await api(`/api/users/${member.user.id}/ban`, { method, headers: { Cookie: administrator.cookie } })).status, method).toBe(404);
    }
    expect(await stored(member.user.id)).toMatchObject({ status: 1 });
  });
});

describe("What deleting your account deletes", () => {
  it("deletes every message and boost of yours in every room you could have written in, DMs too, and your files, telling everyone there", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    const lobby = await freshRoom("lobby");
    const { id: closed } = await createRoom("closed", { closedTo: [administrator.user.id, member.user.id], as: administrator });
    const { id: dm } = await direct(member, administrator);
    const { id: theirs } = await direct(administrator, linus);

    const adaInLobby = await connect(lobby, administrator);
    const graceInLobby = await connect(lobby, member);
    const adas = await post(adaInLobby, "Ada's");
    const graces = await post(graceInLobby, "Grace's");
    await boost(graceInLobby, adas, "🔥");
    await boost(adaInLobby, graces, "👍");
    const { attachment } = await upload(member, lobby, "moon.jpg", recordedImage("moon-thumb.jpg"));
    for (const room of [closed, dm]) await post(await connect(room, member), "Grace's");
    const elsewhere = await post(await connect(theirs, linus), "Linus's");
    // She's taken out of the closed room after writing there.
    await workspaceSql("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", closed, member.user.id);

    await deleteGraces(member);
    await purged();
    for (const room of [lobby, closed, dm]) expect(await written(room, member.user.id), room).toEqual([]);
    expect(await written(lobby, administrator.user.id)).toEqual([adas.id]);
    expect(await written(theirs, linus.user.id)).toEqual([elsewhere.id]);
    // Her boost on Ada's message went, and Ada's on hers with it.
    expect(await boostsIn(lobby)).toEqual([]);
    const { welcome } = await connect(lobby, administrator);
    expect(welcome.messages.map(({ id }) => id)).toEqual([adas.id]);
    expect(welcome.messages[0]!.boosts).toEqual([]);
    await vi.waitFor(async () => expect(await bindings.FILES!.head(objectKey(attachment.id))).toBeNull(), { timeout: 5_000 });

    // Ada's tab heard of each.
    const heard = adaInLobby.log.filter((frame) => frame.type === "message.deleted" || frame.type === "boost.deleted");
    expect(heard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message.deleted", messageId: graces.id }),
        expect.objectContaining({ type: "boost.deleted", messageId: adas.id }),
      ]),
    );
  });

  it("turns away what an AI app connected as you was let send before your account went, however late it reaches the room", async () => {
    await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    // Checked just before Grace deletes her account, and slow to reach the room.
    const sender = (await workspaceStub().outsideSender({ userId: member.user.id, scopes: ["read", "write"] }, lobby)) as OutsideSender;
    expect(sender.user.name).toBe(grace.name);

    await deleteGraces(member);
    await purged();
    expect(await roomStub(lobby).createOutsideMessage(lobby, sender, "<p>Still here</p>")).toBeNull();
    expect(await written(lobby, member.user.id)).toEqual([]);
  });

  it("keeps a message of yours that has replies for them, without its text, as Deleted person's", async () => {
    await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    const lobby = await freshRoom("lobby");
    const graceInLobby = await connect(lobby, member);
    const parent = await post(graceInLobby, "Who found the moth?");
    const answer = await reply(await connect(lobby, linus), parent, "Grace did");
    await settle(graceInLobby);

    await deleteGraces(member);
    await purged();
    expect(await roomSql(lobby, "SELECT id, creator_name, body, deleted FROM messages WHERE room_id = ? AND creator_id = ?", lobby, member.user.id)).toEqual([
      { id: parent.id, creator_name: DELETED_PERSON_NAME, body: "", deleted: 1 },
    ]);
    expect(await written(lobby, linus.user.id)).toEqual([answer.id]);
  });

  it("deletes a page of messages, then of boosts, at a time, each a change of its own that tabs catch up on", async () => {
    await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const graceInLobby = await connect(lobby, member);
    const linusInLobby = await connect(lobby, "Linus Torvalds");
    const theirs = [];
    for (let i = 0; i < 3; i++) theirs.push(await post(linusInLobby, `Linus's ${i}`));
    for (let i = 0; i < 3; i++) await post(graceInLobby, `Grace's ${i}`);
    for (const message of theirs) await boost(graceInLobby, message, "🎉");
    // Her account is deleted without the alarm getting to the room first.
    await workspaceSql("UPDATE users SET deleted_at = ? WHERE id = ?", new Date().toISOString(), member.user.id);
    const watcher = await connect(lobby, linusInLobby.session);
    const { seq } = watcher.welcome;
    const room = roomStub(lobby);

    expect(await room.removeEverythingBy(lobby, member.user.id, 2)).toBe(true);
    expect(await room.removeEverythingBy(lobby, member.user.id, 2)).toBe(true);
    expect(await room.removeEverythingBy(lobby, member.user.id, 2)).toBe(false);
    expect(await room.removeEverythingBy(lobby, member.user.id, 2)).toBe(false);
    const changes = [];
    for (let i = 0; i < 6; i++) changes.push(await watcher.next("message.deleted", "boost.deleted"));
    expect(changes.map((change) => change.type)).toEqual(["message.deleted", "message.deleted", "message.deleted", "boost.deleted", "boost.deleted", "boost.deleted"]);
    expect(changes.map((change) => change.seq)).toEqual([1, 2, 3, 4, 5, 6].map((n) => seq + n));
    expect(await written(lobby, member.user.id)).toEqual([]);
    expect(await boostsIn(lobby)).toEqual([]);

    // A tab that heard the deletions but none of the boosts' catches up on the messages they were on.
    const { opening } = await reconnect(lobby, linusInLobby.session, seq + 3);
    expect(opening).toMatchObject({ type: "resumed", deletedIds: [], seq: seq + 6 });
    const caughtUp = (opening as { messages: Message[] }).messages;
    expect(caughtUp.map(({ id }) => id).sort()).toEqual(theirs.map(({ id }) => id).sort());
    for (const message of caughtUp) expect(message.boosts).toEqual([]);
  });

  it("finds your boosts and what's kept of your messages in a room by the room's indexes, however many others wrote", async () => {
    const lobby = await freshRoom("index-plan");
    const ada = await connect(lobby, "Ada");
    for (const [query, ...params] of [
      [BOOSTS_BY, lobby, ada.me.id, 100],
      [RENAME_AUTHOR, lobby, ada.me.id, DELETED_PERSON_NAME],
    ] as const) {
      const plan = await roomSql(lobby, `EXPLAIN QUERY PLAN ${query}`, ...params);
      const detail = plan.map((row) => (row as { detail: string }).detail).join("; ");
      expect(detail, query).toMatch(/index_boosts_on_room_id_and_booster_id \(room_id=\? AND booster_id=\?\)|index_messages_on_room_id_and_creator_id_and_client_message_id \(room_id=\? AND creator_id=\?\)/);
    }
  });
});

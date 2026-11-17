import {
  CloseCode,
  ROOM_PROTOCOL,
  type ChangedPerson,
  type Directory,
  type DirectoryUser,
  type Invited,
  type Me,
  type NewWorkspace,
  type ProfileAnswer,
  type RoomId,
  type Sidebar,
  type UserId,
} from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { banProblem } from "../src/bans";
import { ADDRESS_HEADER, BANNED_HEADER } from "../src/chat-room";
import type { Env } from "../src/env";
import { RECOVERY_PATH } from "../src/recovery";
import { addressTag, sessionTag, type Revocation } from "../src/revocations";
import { MESSAGES_BY, MESSAGES_BY_UNTIL } from "../src/store";
import type { Workspace } from "../src/workspace";
import { DUE_PURGES, NEXT_PURGE_DUE, ROOM_ACCESS, type WorkspaceStore } from "../src/workspace-store";
import {
  api,
  apiWith,
  closeOf,
  connect,
  cookieOf,
  createRoom,
  deactivatedPerson,
  direct,
  freshDeploy,
  freshRoom,
  openWorkspaceSocket,
  outcome,
  post,
  reconnect,
  recordedImage,
  roomSql,
  roomStub,
  settle,
  shown,
  signIn,
  standInForRooms,
  upgrade,
  upload,
  workspaceSql,
  workspaceStub,
  type Access,
  type Session,
} from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** A time so far ahead that the runtime never runs an alarm set for it during a test. */
const LATER = Date.now() + 365 * 24 * 60 * 60 * 1000;

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

/** Signs in with an email address and password from the IP address `ip`. */
const signInFrom = ({ emailAddress, password }: typeof grace, ip: string) =>
  api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify({ emailAddress, password }) });

/** Signs in as Grace again from `ip`, in a session of its own. */
async function signInAsGrace(ip: string): Promise<Session> {
  const response = await signInFrom(grace, ip);
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Asks for `userId` to be banned, as `session` if given. */
const ban = (session: Session | null, userId: UserId) => api(`/api/users/${userId}/ban`, { method: "POST", headers: session ? { Cookie: session.cookie } : {} });

/** Asks for the ban on `userId` to be lifted, as `session` if given. */
const unban = (session: Session | null, userId: UserId) => api(`/api/users/${userId}/ban`, { method: "DELETE", headers: session ? { Cookie: session.cookie } : {} });

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

const stored = async (userId: UserId) =>
  ((await workspaceSql("SELECT role, status, updated_at FROM users WHERE id = ?", userId)) as Array<{ role: number; status: number; updated_at: string }>)[0]!;

const bansOf = (userId: UserId) => workspaceSql("SELECT ip_address, created_at, updated_at FROM bans WHERE user_id = ? ORDER BY ip_address", userId);

const sessionsOf = async (userId: UserId) => ((await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId)) as Array<{ n: number }>)[0]!.n;

const signedIn = async (session: Session) => (await api("/api/me", { headers: { Cookie: session.cookie } })).status === 200;

/** The rooms `userId` is in, by id. */
const roomsOf = async (userId: UserId) =>
  ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", userId)) as Array<{ room_id: RoomId }>).map(({ room_id }) => room_id);

/** The open rooms, by id. */
const openRooms = async () => ((await workspaceSql("SELECT id FROM rooms WHERE kind = 'open' ORDER BY id")) as Array<{ id: RoomId }>).map(({ id }) => id);

/** Changes room `roomId` as its settings do, as `session`. */
async function changeRoom(session: Session, roomId: RoomId, changes: unknown): Promise<void> {
  const response = await api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(changes) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** The ids of the messages `userId` wrote in `room`, in the order they were written. */
const written = async (room: RoomId, userId: UserId) =>
  ((await roomSql(room, "SELECT id FROM messages WHERE room_id = ? AND creator_id = ? ORDER BY id", room, userId)) as Array<{ id: string }>).map(({ id }) => id);

/** Waits for the Workspace's outbox to have told every room whose sockets to close. */
const revoked = () => vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]), { timeout: 5_000 });

/** Waits for the Workspace's outbox to have asked every room to delete what it was asked to. */
const purged = () => vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_purges")).toEqual([]), { timeout: 5_000 });

/** Waits until room `room` has nothing left in its log, which it forgets once the Workspace has applied it. */
const delivered = (room: RoomId) =>
  vi.waitFor(async () => expect(await roomSql(room, "SELECT seq FROM room_events WHERE room_id = ?", room)).toEqual([]), { timeout: 5_000 });

const alarm = () => runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => state.storage.getAlarm());

/** Queues deleting someone's messages in a room, as banning them does. */
const queuePurge = (roomId: string, userId: string, dueAt: number) =>
  workspaceSql("INSERT INTO pending_purges (room_id, user_id, due_at) VALUES (?, ?, ?)", roomId, userId, dueAt);

const purges = () => workspaceSql("SELECT room_id, user_id, attempts, due_at FROM pending_purges ORDER BY id");

/** What the Workspace's alarm calls, standing in for each room. */
interface Rooms {
  revoke?(roomId: RoomId, revocations: Revocation[], revokedAt: number): Promise<void>;
  removeMessagesBy(roomId: RoomId, userId: UserId, limit: number, liftedAt: string | null): Promise<boolean>;
}

/** Runs the Workspace's alarm, as the runtime does once it's due, with `rooms` answering for the rooms. */
async function runAlarm(rooms: Rooms): Promise<void> {
  await runInDurableObject(workspaceStub(), async (workspace: Workspace, state: DurableObjectState) => {
    // The runtime clears an alarm as it runs it.
    await state.storage.deleteAlarm();
    const object = workspace as unknown as { env: Env };
    const env = object.env;
    object.env = { ...env, CHAT_ROOM: { getByName: () => rooms } as unknown as Env["CHAT_ROOM"] };
    try {
      await workspace.alarm();
    } finally {
      object.env = env;
    }
  });
}

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Ban and unban people", () => {
  it("bans someone active, answering them as the directory then lists them, banned, with their role and avatar", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE users SET role = 1, updated_at = ? WHERE id = ?", long, member.user.id);
    const before = await listed(administrator, member.user.id);

    const response = await ban(administrator, member.user.id);
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as ChangedPerson;
    expect(user).toEqual(await listed(administrator, member.user.id));
    expect(user).toMatchObject({ id: member.user.id, name: "Grace Hopper", role: "administrator", status: "banned" });
    // Its time changed, and the avatar's address with it.
    expect(user.avatarUrl).not.toBe(before.avatarUrl);
    expect((await api(user.avatarUrl, { headers: { Cookie: administrator.cookie } })).status).toBe(200);
    expect(await stored(member.user.id)).toMatchObject({ status: 2, role: 1 });
    expect((await stored(member.user.id)).updated_at > long).toBe(true);
  });

  it("blocks each IP address their sessions were signed in from, once each, leaving out blank ones", async () => {
    const administrator = await setUp();
    // With no address, as the tests' requests come.
    const member = await join(grace);
    for (const ip of ["203.0.113.7", "203.0.113.7", "2001:db8::7", "198.51.100.1"]) await signInAsGrace(ip);
    await workspaceSql("UPDATE sessions SET ip_address = ' ' WHERE ip_address = '198.51.100.1'");
    await signInFrom(ada, "192.0.2.1");

    await ban(administrator, member.user.id);
    const { updated_at: bannedAt } = await stored(member.user.id);
    expect(await bansOf(member.user.id)).toEqual(["2001:db8::7", "203.0.113.7"].map((ip_address) => ({ ip_address, created_at: bannedAt, updated_at: bannedAt })));
    expect(await workspaceSql("SELECT count(*) AS n FROM bans")).toEqual([{ n: 2 }]);
  });

  it("refuses to ban someone signed in from an address a ban can't block, changing nothing", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const message = await post(await connect(lobby, member), "Still here");
    const phone = await signInAsGrace("203.0.113.7");
    await signInAsGrace("10.0.0.1");

    const internal = await ban(administrator, member.user.id);
    expect(internal.status).toBe(422);
    expect(await internal.json()).toEqual({ error: "They signed in from a private or internal IP address, which a ban can't block" });

    await workspaceSql("UPDATE sessions SET ip_address = 'not an ip' WHERE ip_address = '10.0.0.1'");
    const invalid = await ban(administrator, member.user.id);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "They signed in from an IP address that isn't valid, which a ban can't block" });

    expect(await stored(member.user.id)).toMatchObject({ status: 0 });
    expect(await sessionsOf(member.user.id)).toBe(3);
    expect(await signedIn(phone)).toBe(true);
    expect(await workspaceSql("SELECT * FROM bans")).toEqual([]);
    expect(await workspaceSql("SELECT * FROM pending_purges")).toEqual([]);
    expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]);
    expect(await written(lobby, member.user.id)).toEqual([message.id]);
  });

  it("bans someone signed in from a public IPv6 address that ends as an IPv4-mapped private one does", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lookalike = "2001:db8:1:2:0:ffff:a00:1";
    const phone = await signInAsGrace(lookalike);

    expect((await ban(administrator, member.user.id)).status).toBe(200);
    expect(await stored(member.user.id)).toMatchObject({ status: 2 });
    expect(await sessionsOf(member.user.id)).toBe(0);
    expect(await signedIn(phone)).toBe(false);
    expect(await bansOf(member.user.id)).toMatchObject([{ ip_address: lookalike }]);
  });

  it("ends all their sessions and nobody else's, closing their sockets for good in every room, their DMs too, and the workspace's", async () => {
    const administrator = await setUp();
    const laptop = await join(grace);
    const phone = await signInAsGrace("203.0.113.7");
    const lobby = await freshRoom("lobby");
    const annex = await freshRoom("annex");
    const { id: dm } = await direct(laptop, administrator);
    const rooms = [await connect(lobby, laptop), await connect(annex, laptop), await connect(lobby, phone), await connect(dm, phone)];
    const workspaces = [await openWorkspaceSocket(laptop), await openWorkspaceSocket(phone)];
    const adaInLobby = await connect(lobby, administrator);
    const adasWorkspace = await openWorkspaceSocket(administrator);
    const closes = [...rooms.map((tab) => closeOf(tab.ws)), ...workspaces.map((tab) => tab.closed)];

    expect((await ban(administrator, laptop.user.id)).status).toBe(200);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Revoked, reason: "Revoked" });
    // Rooms she has no tab in hear too, and then nothing waits to be told again.
    await revoked();
    for (const session of [laptop, phone]) {
      expect(await signedIn(session)).toBe(false);
      expect((await api(`/api/rooms/${dm}/socket`, upgrade(session.cookie))).status).toBe(401);
      expect((await api("/api/socket", upgrade(session.cookie))).status).toBe(401);
    }
    expect(await sessionsOf(laptop.user.id)).toBe(0);
    // Nor can she sign in again.
    expect((await signInFrom(grace, "203.0.113.8")).status).toBe(401);

    // Ada is still signed in and connected.
    expect(await signedIn(administrator)).toBe(true);
    expect((await post(adaInLobby, "Still here")).body).toBe("Still here");
    expect(await adasWorkspace.next()).toMatchObject({ type: "user.updated", user: { id: laptop.user.id, status: "banned" } });
    expect(await adasWorkspace.answers()).toBe(true);
  });

  it("refuses their sign-in links from then on", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const { transferId } = (await (await api("/api/users/me/profile", { headers: { Cookie: member.cookie } })).json()) as ProfileAnswer;

    await ban(administrator, member.user.id);
    expect((await api("/api/session/transfers", { method: "POST", body: JSON.stringify({ transferId }) })).status).toBe(400);
  });

  it("deletes every message they wrote, in every room they could have written in, with its boosts, telling everyone there", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    const lobby = await freshRoom("lobby");
    const { id: closed } = await createRoom("closed", { closedTo: [administrator.user.id, member.user.id], as: administrator });
    const { id: dm } = await direct(member, administrator);
    const { id: group } = await direct(member, administrator, linus);
    const { id: own } = await direct(member);
    const { id: theirs } = await direct(administrator, linus);

    const adaInLobby = await connect(lobby, administrator);
    const graceInLobby = await connect(lobby, member);
    const adas = await post(adaInLobby, "Ada's");
    const graces = await post(graceInLobby, "Grace's");
    graceInLobby.send({ type: "boost.create", messageId: adas.id, content: "🔥" });
    await adaInLobby.next("boost.created");
    adaInLobby.send({ type: "boost.create", messageId: graces.id, content: "👍" });
    await adaInLobby.next("boost.created");
    for (const room of [closed, dm, group, own]) await post(await connect(room, member), "Grace's");
    const linuss = await post(await connect(group, linus), "Linus's");
    const elsewhere = await post(await connect(theirs, administrator), "Not in Grace's rooms");
    // She's taken out of the closed room after writing there.
    await workspaceSql("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", closed, member.user.id);

    expect((await ban(administrator, member.user.id)).status).toBe(200);
    expect(await adaInLobby.next("message.deleted")).toEqual({ type: "message.deleted", messageId: graces.id, seq: expect.any(Number) });
    await purged();
    for (const room of [lobby, closed, dm, group, own]) expect(await written(room, member.user.id), room).toEqual([]);
    expect(await written(lobby, administrator.user.id)).toEqual([adas.id]);
    expect(await written(group, linus.user.id)).toEqual([linuss.id]);
    expect(await written(theirs, administrator.user.id)).toEqual([elsewhere.id]);
    // Her boost on Ada's message stays, and Ada's on hers went with it.
    expect(await roomSql(lobby, "SELECT message_id, booster_id FROM boosts WHERE room_id = ?", lobby)).toEqual([{ message_id: adas.id, booster_id: member.user.id }]);
    // A new tab doesn't see them either.
    expect((await connect(lobby, administrator)).welcome.messages.map(({ id }) => id)).toEqual([adas.id]);
  });

  it("deletes a page of their messages at a time, each deletion a change of its own that tabs catch up on", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const graceInLobby = await connect(lobby, member);
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) ids.push((await post(graceInLobby, `Message ${i}`)).id);
    const adaInLobby = await connect(lobby, administrator);
    const { seq } = adaInLobby.welcome;

    await ban(administrator, member.user.id);
    const deletions = [];
    for (let i = 0; i < ids.length; i++) deletions.push(await adaInLobby.next("message.deleted"));
    expect(deletions.map((deletion) => deletion.seq)).toEqual(ids.map((_, i) => seq + 1 + i));
    expect(deletions.map((deletion) => deletion.messageId).sort()).toEqual([...ids].sort());
    await purged();
    expect(await written(lobby, member.user.id)).toEqual([]);

    // A tab that saw the first five deletions catches up on the rest, the latest the room keeps.
    const { opening } = await reconnect(lobby, administrator, seq + 5);
    expect(opening).toEqual({
      type: "resumed",
      you: administrator.user,
      messages: [],
      deletedIds: deletions.slice(5).map((deletion) => deletion.messageId),
      present: expect.any(Array),
      seq: seq + 105,
    });
    // One that saw none of them is too far behind, and starts again with the newest page.
    expect((await reconnect(lobby, administrator, seq)).opening).toMatchObject({ type: "welcome", messages: [], seq: seq + 105 });
  });

  it("queues deleting their messages in every shared room and every DM of theirs, in the change that bans them", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    await freshRoom("lobby");
    // A room she isn't in now, as she may have been once.
    await createRoom("closed", { closedTo: [administrator.user.id], as: administrator });
    const { id: dm } = await direct(member, administrator);
    const { id: own } = await direct(member);
    await direct(administrator, linus);
    const shared = ((await workspaceSql("SELECT id FROM rooms WHERE kind <> 'direct'")) as Array<{ id: string }>).map(({ id }) => id);
    expect(shared).toHaveLength(4);

    const queued = await runInDurableObject(workspaceStub(), (workspace: Workspace) =>
      (workspace as unknown as { store: WorkspaceStore }).store.banPerson(member.user.id, [], CloseCode.Revoked, CloseCode.Reconnect, LATER, new Date().toISOString()),
    );
    expect(queued).toBe(true);
    expect(await workspaceSql("SELECT room_id, user_id, attempts, due_at FROM pending_purges ORDER BY room_id")).toEqual(
      [...shared, dm, own].sort().map((room_id) => ({ room_id, user_id: member.user.id, attempts: 0, due_at: LATER })),
    );
  });

  it("leaves someone banned as they were when banned again, telling nobody", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const { user } = (await (await ban(administrator, member.user.id)).json()) as ChangedPerson;
    const socket = await openWorkspaceSocket(administrator);

    const again = await ban(administrator, member.user.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ user });
    expect(await socket.answers()).toBe(true);
  });

  it("bans removed people and bots too", async () => {
    const administrator = await setUp();
    const removed = await deactivatedPerson("Former");
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES ('robot', 'Build Bot', 2, ?, ?)", now, now);
    for (const userId of [removed, "robot"]) {
      const response = await ban(administrator, userId);
      expect(response.status, userId).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: userId, status: "banned" } });
    }
  });

  it("tells everyone's workspace sockets they're banned, as the directory now lists them", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(linus)];

    const { user } = (await (await ban(administrator, member.user.id)).json()) as ChangedPerson;
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "user.updated", user });
  });

  it("lets only administrators ban people, telling anyone else so before looking at whom", async () => {
    await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    for (const userId of [linus.user.id, member.user.id, "nobody"]) {
      const response = await ban(member, userId);
      expect(response.status, userId).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can ban people" });
    }
    expect((await stored(linus.user.id)).status).toBe(0);
  });

  it("finds nobody with an id nobody has", async () => {
    const administrator = await setUp();
    for (const userId of ["nobody", "%61"]) {
      const response = await ban(administrator, userId);
      expect(response.status, userId).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  });

  it("doesn't let administrators ban themselves, so there's always one", async () => {
    const administrator = await setUp();
    const response = await ban(administrator, administrator.user.id);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Administrators can't ban themselves" });
    expect(await signedIn(administrator)).toBe(true);
  });

  it("asks who's signed in", async () => {
    await setUp();
    const member = await join(grace);
    expect((await ban(null, member.user.id)).status).toBe(401);
    expect(await signedIn(member)).toBe(true);
  });

  it("still closes their sockets and deletes their messages when the database saves the ban but its answer is lost", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const graceInLobby = await connect(lobby, member);
    await post(graceInLobby, "Doomed");
    const closes = [closeOf(graceInLobby.ws), (await openWorkspaceSocket(member)).closed];
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const banPerson = store.banPerson.bind(store);
      store.banPerson = async (...args) => {
        await banPerson(...args);
        throw new Error("The database's answer was lost");
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await ban(administrator, member.user.id)).status).toBe(500);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Revoked });
    expect(await signedIn(member)).toBe(false);
    await purged();
    expect(await written(lobby, member.user.id)).toEqual([]);
  });

  it("lifts a ban, unblocking their addresses and making them active, without bringing back their messages", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace("203.0.113.7");
    const lobby = await freshRoom("lobby");
    await post(await connect(lobby, member), "Gone for good");
    await ban(administrator, member.user.id);
    await purged();
    // The lobby has told the Workspace of the message, which marks it unread, before anyone's socket opens to hear it.
    await delivered(lobby);
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", member.user.id);
    const banned = await listed(administrator, member.user.id);
    // Signed in first, as every open tab hears of someone new.
    const linus = await signIn("Linus Torvalds");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(linus)];

    const response = await unban(administrator, member.user.id);
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as ChangedPerson;
    expect(user).toEqual(await listed(administrator, member.user.id));
    expect(user).toMatchObject({ id: member.user.id, status: "active", role: "member" });
    // Its time changed, and the avatar's address with it.
    expect(user.avatarUrl).not.toBe(banned.avatarUrl);
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "user.updated", user });
    expect(await bansOf(member.user.id)).toEqual([]);
    expect(await stored(member.user.id)).toMatchObject({ status: 0 });
    expect(await written(lobby, member.user.id)).toEqual([]);
    expect((await signInFrom(grace, "203.0.113.7")).status).toBe(201);
  });

  it("puts them back in their rooms and every open room, those made or opened while they were banned too", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const team = await createRoom("Team", { closedTo: [administrator.user.id, member.user.id], as: administrator });
    const before = await roomsOf(member.user.id);
    await ban(administrator, member.user.id);
    await purged();
    // While she's banned, an open room is made, a private one is opened, and another made without her.
    const launch = await createRoom("Launch", { as: administrator });
    const leads = await createRoom("Leads", { closedTo: [administrator.user.id], as: administrator });
    await changeRoom(administrator, leads.id, { kind: "open" });
    const board = await createRoom("Board", { closedTo: [administrator.user.id], as: administrator });
    // Her rooms stay hers, but those made or opened meanwhile leave her out.
    expect(await roomsOf(member.user.id)).toEqual(before);

    expect((await unban(administrator, member.user.id)).status).toBe(200);
    expect(await openRooms()).toEqual(expect.arrayContaining([launch.id, leads.id]));
    expect(await roomsOf(member.user.id)).toEqual([...(await openRooms()), team.id].sort());
    expect(await roomsOf(member.user.id)).not.toContain(board.id);
    // As her sidebar lists them once she's signed in again.
    const back = await signInAsGrace("203.0.113.7");
    const { rooms } = (await (await api("/api/sidebar", { headers: { Cookie: back.cookie } })).json()) as Sidebar;
    expect(rooms.map(({ id }) => id).sort()).toEqual(await roomsOf(member.user.id));
  });

  it("keeps what they write once the ban is lifted, however late a room answers, deleting everything of theirs from before", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const graceInLobby = await connect(lobby, member);
    await post(graceInLobby, "Before the ban");
    // A year on, so the alarm the ban sets waits for the test, as the outbox does for a room it can't reach;
    // and the lobby can't be reached as she's banned, so the ban answers with her socket still open.
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const giveBack = await standInForRooms({ revoke: () => Promise.reject(new Error("Unreachable")) });
    expect((await ban(administrator, member.user.id)).status).toBe(200);
    await giveBack();
    vi.setSystemTime(LATER + 1_000);
    // Through the socket she had, which the lobby hasn't closed.
    await post(graceInLobby, "While banned");
    vi.setSystemTime(LATER + 2_000);
    expect((await unban(administrator, member.user.id)).status).toBe(200);
    vi.setSystemTime(LATER + 3_000);
    const back = await post(await connect(lobby, await signInAsGrace("203.0.113.7")), "Once back");
    expect(await workspaceSql("SELECT DISTINCT lifted_at FROM pending_purges")).toEqual([{ lifted_at: new Date(LATER + 2_000).toISOString() }]);

    await runInDurableObject(workspaceStub(), (workspace: Workspace) => workspace.alarm());
    expect(await written(lobby, member.user.id)).toEqual([back.id]);
    expect(await workspaceSql("SELECT * FROM pending_purges")).toEqual([]);
  });

  it("keeps what they write once the ban is lifted while it's asking rooms to delete theirs, in the rooms it asks after, however often it's lifted", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    expect((await ban(administrator, member.user.id)).status).toBe(200);
    // More rooms than it asks at once, so it asks the last only once the first have answered.
    for (const room of ["r1", "r2", "r3", "r4", "r5", "r6"]) await queuePurge(room, member.user.id, LATER);
    const queued = (await purges()).length;
    let lift!: () => void;
    const lifted = new Promise<void>((resolve) => (lift = resolve));
    const cutoffs: Array<string | null> = [];
    const rooms: Rooms = {
      revoke: async () => {},
      removeMessagesBy: async (_roomId, _userId, _limit, liftedAt) => {
        cutoffs.push(liftedAt);
        if (cutoffs.length === 1) {
          vi.setSystemTime(LATER + 2_000);
          expect((await unban(administrator, member.user.id)).status).toBe(200);
          // Their purges keep the time it was first lifted, and so do the rooms it asks after.
          vi.setSystemTime(LATER + 4_000);
          expect((await unban(administrator, member.user.id)).status).toBe(200);
          lift();
        }
        await lifted;
        return false;
      },
    };

    await runAlarm(rooms);
    expect(cutoffs).toEqual([...Array(6).fill(null), ...Array(queued - 6).fill(new Date(LATER + 2_000).toISOString())]);
    expect(await purges()).toEqual([]);
  });

  it("leaves someone active as they are, telling nobody", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const socket = await openWorkspaceSocket(administrator);
    const response = await unban(administrator, member.user.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: await listed(administrator, member.user.id) });
    expect(await socket.answers()).toBe(true);
  });

  it("makes whoever it's lifted for active in every open room, removed people and bots too", async () => {
    const administrator = await setUp();
    const removed = await deactivatedPerson("Former");
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, role, status, created_at, updated_at) VALUES ('robot', 'Build Bot', 2, 2, ?, ?)", now, now);
    for (const userId of [removed, "robot"]) {
      const response = await unban(administrator, userId);
      expect(response.status, userId).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: userId, status: "active" } });
      expect(await roomsOf(userId), userId).toEqual(await openRooms());
    }
  });

  it("lets only administrators lift bans, finding anyone whatever their status", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    await ban(administrator, linus.user.id);
    for (const userId of [linus.user.id, "nobody"]) {
      const response = await unban(member, userId);
      expect(response.status, userId).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can lift bans" });
    }
    expect((await stored(linus.user.id)).status).toBe(2);
    const nobody = await unban(administrator, "nobody");
    expect(nobody.status).toBe(404);
    expect(await nobody.json()).toEqual({ error: "Not found" });
    expect((await unban(null, linus.user.id)).status).toBe(401);
  });

  it("asks each room to delete a page of their messages, and again at once while it has more", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    await queuePurge("lobby", "u1", LATER);
    await queuePurge("annex", "u1", LATER);
    await queuePurge("lobby", "u2", LATER + 1);
    const calls: unknown[] = [];
    let more = true;
    const rooms: Rooms = {
      removeMessagesBy: async (...call) => {
        calls.push(call);
        return call[0] === "lobby" && more;
      },
    };

    await runAlarm(rooms);
    expect(calls).toEqual([
      ["lobby", "u1", 100, null],
      ["annex", "u1", 100, null],
    ]);
    expect(await purges()).toEqual([
      { room_id: "lobby", user_id: "u1", attempts: 0, due_at: LATER },
      { room_id: "lobby", user_id: "u2", attempts: 0, due_at: LATER + 1 },
    ]);
    expect(await alarm()).toBe(LATER);

    more = false;
    await runAlarm(rooms);
    expect(calls).toHaveLength(3);
    expect(await purges()).toEqual([{ room_id: "lobby", user_id: "u2", attempts: 0, due_at: LATER + 1 }]);
    expect(await alarm()).toBe(LATER + 1);
  });

  it("never gives up on a room it can't reach, trying again twice as long after each time, up to the longest wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await queuePurge("lobby", "u1", LATER);
    let reachable = false;
    const rooms: Rooms = {
      removeMessagesBy: async () => {
        if (!reachable) throw new Error("The lobby isn't answering");
        return false;
      },
    };

    let now = LATER;
    for (let tries = 1; tries <= 12; tries++) {
      await runAlarm(rooms);
      const wait = Math.min(1000 * 2 ** (tries - 1), 5 * 60 * 1000);
      expect(await purges()).toEqual([{ room_id: "lobby", user_id: "u1", attempts: tries, due_at: now + wait }]);
      expect(await alarm()).toBe(now + wait);
      vi.setSystemTime((now += wait));
    }
    // However often it has failed.
    await workspaceSql("UPDATE pending_purges SET attempts = 100");
    await runAlarm(rooms);
    expect(await purges()).toEqual([{ room_id: "lobby", user_id: "u1", attempts: 101, due_at: now + 5 * 60 * 1000 }]);
    vi.setSystemTime((now += 5 * 60 * 1000));

    reachable = true;
    await runAlarm(rooms);
    expect(await purges()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(13);
  });

  it("delivers 40 rows of its outbox a run, revocations first and then purges, and sets its alarm for the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const named = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
    const [revoking, purging] = [named("revoking", 30), named("purging", 15)];
    await workspaceSql(
      "INSERT INTO pending_revocations (room_id, tag, code, due_at) SELECT value, 'u1', ?, ? FROM json_each(?)",
      CloseCode.Revoked,
      LATER,
      JSON.stringify(revoking),
    );
    await workspaceSql("INSERT INTO pending_purges (room_id, user_id, due_at) SELECT value, 'u1', ? FROM json_each(?)", LATER, JSON.stringify(purging));
    const calls: RoomId[] = [];
    const rooms: Rooms = {
      revoke: async (roomId) => void calls.push(roomId),
      removeMessagesBy: async (roomId) => {
        calls.push(roomId);
        return false;
      },
    };

    await runAlarm(rooms);
    expect(calls).toEqual([...revoking, ...purging.slice(0, 10)]);
    expect(await alarm()).toBe(LATER);
    await runAlarm(rooms);
    expect(calls).toEqual([...revoking, ...purging]);
    expect(await purges()).toEqual([]);
    expect(await alarm()).toBeNull();
  });

  it("asks a room to delete their messages only once it has no sockets left to close, which they could write through", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await workspaceSql("INSERT INTO pending_revocations (room_id, tag, code, due_at) VALUES ('lobby', 's:1', ?, ?)", CloseCode.Revoked, LATER);
    await queuePurge("lobby", "u1", LATER);
    await queuePurge("annex", "u1", LATER);
    let reachable = false;
    const calls: RoomId[] = [];
    const rooms: Rooms = {
      revoke: async () => {
        if (!reachable) throw new Error("The lobby isn't answering");
      },
      removeMessagesBy: async (roomId) => {
        calls.push(roomId);
        return false;
      },
    };

    await runAlarm(rooms);
    expect(calls).toEqual(["annex"]);
    expect(await purges()).toEqual([{ room_id: "lobby", user_id: "u1", attempts: 0, due_at: LATER }]);
    // When the revocation is tried again, rather than at once for a purge the lobby can't take yet.
    expect(await alarm()).toBe(LATER + 1000);

    vi.setSystemTime(LATER + 1000);
    reachable = true;
    await runAlarm(rooms);
    expect(calls).toEqual(["annex", "lobby"]);
    expect(await purges()).toEqual([]);
    expect(await alarm()).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
  });

  it("forgets a deleted room's purges, its messages gone with it", async () => {
    const administrator = await setUp();
    const room = await createRoom("doomed", { as: administrator });
    await queuePurge(room.id, "u1", LATER);
    await queuePurge("elsewhere", "u1", LATER);
    expect((await api(`/api/rooms/${room.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
    expect(await purges()).toEqual([{ room_id: "elsewhere", user_id: "u1", attempts: 0, due_at: LATER }]);
  });

  it("never gives a purge the id of one a room took with it while the alarm was asking that room, which it settles by", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: LATER });
    await queuePurge("doomed", "u1", LATER);
    const rooms: Rooms = {
      removeMessagesBy: async (roomId) => {
        if (roomId === "doomed") {
          // Meanwhile the room is deleted, as `deleteRoom` deletes its purges, and someone else is banned.
          await workspaceSql("DELETE FROM pending_purges WHERE room_id = ?", roomId);
          await queuePurge("lobby", "u2", LATER);
        }
        return false;
      },
    };

    await runAlarm(rooms);
    expect(await purges()).toEqual([{ room_id: "lobby", user_id: "u2", attempts: 0, due_at: LATER }]);
  });

  it("finds the purges that are due, and when the next is, by their index, however many are waiting", async () => {
    for (const [query, ...params] of [[DUE_PURGES, 0, 40], [NEXT_PURGE_DUE]] as const) {
      const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");
      expect(plan, query).toContain("USING INDEX index_pending_purges_on_due_at");
      expect(plan, query).not.toContain("TEMP B-TREE");
    }
  });

  it("finds someone's messages in a room by the room's index, however many others wrote, before a time or not", async () => {
    const room = await freshRoom("purge-plan");
    const ada = await connect(room, "Ada");
    const queries: Array<[string, ...Array<string | number>]> = [
      [MESSAGES_BY, room, ada.me.id, 100],
      [MESSAGES_BY_UNTIL, room, ada.me.id, new Date().toISOString(), 100],
    ];
    for (const [query, ...params] of queries) {
      const plan = await roomSql(room, `EXPLAIN QUERY PLAN ${query}`, ...params);
      expect(plan.map((row) => (row as { detail: string }).detail).join("; "), query).toContain(
        "index_messages_on_room_id_and_creator_id_and_client_message_id (room_id=? AND creator_id=?)",
      );
    }
  });

  // The tests of `Ban::validate`, and more of what it inherits from Rust's `IpAddr` and Ruby's `IPAddr`.
  describe("which addresses a ban can block", () => {
    it("blocks public addresses", () => {
      for (const ip of ["8.8.8.8", "2001:4860:4860::8888", "203.0.113.7", "::ffff:8.8.8.8", "FE00::1", "fec0::1", "::1.2.3.4", "::"]) {
        expect(banProblem(ip), ip).toBeNull();
      }
    });

    it("can't block loopback, private or link-local addresses, IPv4-mapped ones included", () => {
      const internal = [
        ...["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254"],
        ...["::1", "fc00::1", "fd12::1", "fe80::1", "FEBF::1", "[::1]"],
        ...["::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe"],
      ];
      for (const ip of internal) expect(banProblem(ip), ip).toBe("internal");
    });

    it("takes only an address in ::ffff:0:0/96 for an IPv4-mapped one, unlike Ruby, which takes any with ffff before its last 32 bits", () => {
      // Public addresses, which someone could otherwise sign in from so that nobody could ban them.
      const lookalikes = [
        ...["1::ffff:10.0.0.1", "2001:db8:1:2:0:ffff:a00:1", "::1:ffff:10.0.0.1", "8000::ffff:10.0.0.1"],
        ...["2001:db8::ffff:127.0.0.1", "2001:db8::ffff:172.16.0.1", "2001:db8::ffff:c0a8:101", "2001:db8::ffff:a9fe:a9fe"],
      ];
      for (const ip of lookalikes) expect(banProblem(ip), ip).toBeNull();
      expect(banProblem("1::ffff:8.8.8.8")).toBeNull();
      expect(banProblem("0:0:0:0:0:ffff:a00:1")).toBe("internal");
    });

    it("masks an address with its prefix, as Ruby's IPAddr does, and takes one in brackets", () => {
      expect(banProblem("203.0.113.7/24")).toBeNull();
      expect(banProblem("10.0.0.1/8")).toBe("internal");
      // What's left once it's masked is what counts.
      expect(banProblem("10.0.0.1/0")).toBeNull();
      expect(banProblem("fe80::1/10")).toBe("internal");
      expect(banProblem("8.8.8.8/+8")).toBeNull();
      expect(banProblem("[2001:db8::1]")).toBeNull();
      expect(banProblem("[8.8.8.8]")).toBeNull();
    });

    it("finds garbage invalid, and whatever else Rust's parser refuses", () => {
      const invalid = [
        ...["not an ip", "", " 8.8.8.8", "08.8.8.8", "1.2.3", "1.2.3.4.5", "256.0.0.1", "1.2.3.4:80"],
        ...["1:2:3:4:5:6:7:8:9", "1::2::3", "1:2:3:4:5:6:7:1.2.3.4", "1.2.3.4::1", ":::", "1:", ":1", "12345::1"],
        ...["8.8.8.8/", "8.8.8.8/33", "2001:db8::/129", "8.8.8.8/-1", "8.8.8.8/8/8", "[]", "[", "[8.8.8.8"],
      ];
      for (const ip of invalid) expect(banProblem(ip), ip).toBe("invalid");
      for (const ip of ["1:2:3:4:5:6:7:8", "::1:2:3:4:5:6:7", "1:2:3:4:5:6:7::", "1:2:3:4:5:6:1.2.3.4", "0001::1"]) {
        expect(banProblem(ip), ip).toBeNull();
      }
    });
  });
});

describe("What a ban blocks", () => {
  const banned = "203.0.113.7";

  /** `init` sent from the IP address `ip`, in `session` if given. */
  function fromAddress(ip: string, session: Session | null, init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    headers.set("CF-Connecting-IP", ip);
    if (session) headers.set("Cookie", session.cookie);
    return { ...init, headers };
  }

  /** Signs in as a guest named `name` from the IP address `ip`. */
  const guestFrom = (ip: string, name = "Hal") => api("/api/session", fromAddress(ip, null, { method: "POST", body: JSON.stringify({ name }) }));

  /** Sets Ember up with Ada as its administrator, and bans Grace, who signed in from `banned`. */
  async function banGrace(): Promise<{ administrator: Session; member: Session }> {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace(banned);
    expect((await ban(administrator, member.user.id)).status).toBe(200);
    return { administrator, member };
  }

  it("answers everything a banned address asks to change with an empty 429, signing in, joining and out included", async () => {
    const { administrator, member } = await banGrace();
    const linus = await signIn("Linus Torvalds");
    const room = await createRoom("lobby", { as: administrator });
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const { transferId } = (await (await api("/api/users/me/profile", { headers: { Cookie: linus.cookie } })).json()) as ProfileAnswer;
    const invited = await api("/api/invitations", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ emailAddresses: ["hal@example.com"] }) });
    const [outcome] = ((await invited.json()) as Invited).outcomes;
    if (!outcome || "member" in outcome) throw new Error("hal@example.com wasn't invited");
    const { invitation, link } = outcome;
    const token = new URL(link!).hash.slice("#token=".length);
    const everything = () =>
      Promise.all(
        ["accounts", "bans", "email_link_requests", "email_links", "favorites", "memberships", "password_resets", "rooms", "sessions", "users"].map((table) =>
          workspaceSql(`SELECT * FROM ${table} ORDER BY rowid`),
        ),
      );
    const before = await everything();
    const writes: Array<[method: string, path: string, body?: unknown]> = [
      ["POST", "/api/first_run", ada],
      ["POST", "/api/session", { emailAddress: ada.emailAddress, password: ada.password }],
      ["POST", "/api/session", { name: "Hal" }],
      ["DELETE", "/api/session"],
      ["POST", "/api/session/transfers", { transferId }],
      ["POST", `/api/join/${joinCode}`, { name: "Hal", emailAddress: "hal@example.com", password: "heuristically" }],
      ["POST", "/api/join", { name: "Hal", emailAddress: "hal@example.com", password: "heuristically" }],
      ["POST", "/api/email_links/lookup", { token }],
      ["POST", "/api/join/invitation", { name: "Hal", password: "heuristically", token }],
      ["POST", "/api/email_links", { emailAddress: "hal@example.org" }],
      ["POST", "/api/join/email", { name: "Hal", password: "heuristically", token }],
      ["POST", "/api/password_resets", { emailAddress: ada.emailAddress }],
      ["PUT", "/api/password_resets", { emailAddress: ada.emailAddress, code: "12345678", password: "new password" }],
      ["PATCH", "/api/account", { name: "Banned" }],
      ["POST", "/api/invitations", { emailAddresses: ["linus@example.com"] }],
      ["POST", `/api/invitations/${invitation.id}/resend`],
      ["DELETE", `/api/invitations/${invitation.id}`],
      ["POST", "/api/account/join_code"],
      ["PATCH", "/api/account/custom_styles", { customStyles: "body { color: red }" }],
      ["PATCH", `/api/account/users/${linus.user.id}`, { role: "administrator" }],
      ["DELETE", `/api/account/users/${linus.user.id}`],
      ["PUT", "/api/sidebar/order", { roomIds: [] }],
      ["PATCH", "/api/users/me/profile", { name: "Ada King" }],
      ["POST", `/api/users/${linus.user.id}/ban`],
      ["DELETE", `/api/users/${member.user.id}/ban`],
      ["POST", "/api/rooms", { name: "Banned" }],
      ["POST", "/api/directs", { userIds: [linus.user.id] }],
      ["POST", "/api/unfurl", { url: "https://example.com/" }],
      ["PUT", `/api/rooms/${room.id}/favorite`, { favorite: true }],
      ["POST", `/api/rooms/${room.id}/uploads`, { name: "moon.jpg", type: "", size: 1 }],
      ["PUT", `/api/rooms/${room.id}/uploads/${"0".repeat(28)}/parts/1`],
      ["PATCH", `/api/rooms/${room.id}`, { name: "Banned" }],
      ["DELETE", `/api/rooms/${room.id}`],
    ];
    for (const [method, path, body] of writes) {
      const response = await api(path, fromAddress(banned, administrator, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
      expect(response.status, `${method} ${path}`).toBe(429);
      expect(response.headers.get("Content-Type"), `${method} ${path}`).toBe("text/html");
      expect(response.headers.get("Set-Cookie"), `${method} ${path}`).toBeNull();
      expect(await response.text(), `${method} ${path}`).toBe("");
    }

    expect(await everything()).toEqual(before);
    expect(await signedIn(administrator)).toBe(true);
    // Elsewhere, the sign-in link still works.
    expect((await api("/api/session/transfers", { method: "POST", body: JSON.stringify({ transferId }) })).status).toBe(201);
  });

  it("still lets a banned address read, connect and check Ember's health, and finds nothing where no route is", async () => {
    const { administrator } = await banGrace();
    const lobby = await freshRoom("lobby");
    for (const path of ["/api/bootstrap", "/api/me", "/api/users", "/api/sidebar", "/api/account", `/api/rooms/${lobby}/settings`]) {
      expect((await api(path, fromAddress(banned, administrator))).status, path).toBe(200);
    }
    expect((await api("/api/health", fromAddress(banned, null))).status).toBe(200);
    const { attachment } = await upload(administrator, lobby, "moon.jpg", recordedImage("moon-thumb.jpg"));
    expect((await api(attachment.url, fromAddress(banned, null))).status).toBe(200);
    expect((await connect(lobby, { ...administrator, ip: banned })).welcome.type).toBe("welcome");
    expect((await openWorkspaceSocket({ ...administrator, ip: banned })).welcome.type).toBe("welcome");
    for (const method of ["POST", "PUT", "DELETE"]) expect((await api("/api/nothing", fromAddress(banned, administrator, { method }))).status, method).toBe(404);
  });

  it("checks the ban before a request from another site or an old browser", async () => {
    const { administrator } = await banGrace();
    const crossSite = { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ name: "Hal" }) };
    expect((await api("/api/session", fromAddress(banned, null, crossSite))).status).toBe(429);
    expect((await api("/api/session", fromAddress("203.0.113.8", null, crossSite))).status).toBe(422);

    // Chrome 119, one version too old.
    const oldChrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.199 Safari/537.36";
    const outdated = { method: "PATCH", headers: { "User-Agent": oldChrome }, body: JSON.stringify({ name: "Ada King" }) };
    expect((await api("/api/users/me/profile", fromAddress(banned, administrator, outdated))).status).toBe(429);
    const elsewhere = await api("/api/users/me/profile", fromAddress("203.0.113.8", administrator, outdated));
    expect(elsewhere.status).toBe(200);
    expect(await elsewhere.text()).toContain("Upgrade to a supported web browser");
  });

  it("leaves password recovery to its script wherever it runs", async () => {
    await banGrace();
    const token = "0123456789abcdef".repeat(4);
    const response = await apiWith({ EMBER_RECOVERY_TOKEN: token }, RECOVERY_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": banned, "Content-Type": "application/json" },
      body: JSON.stringify({ emailAddress: ada.emailAddress, password: "new password" }),
    });
    expect(response.status).toBe(200);
  });

  it("blocks just the addresses banned, written as they were", async () => {
    await banGrace();
    for (const ip of ["203.0.113.70", "203.0.113.8", "::ffff:203.0.113.7", "2001:db8::7"]) expect((await guestFrom(ip)).status, ip).toBe(201);
    expect((await guestFrom(banned)).status).toBe(429);
  });

  it("blocks an address at once when banned and unblocks it when lifted, unless another ban holds it", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace(banned);
    const linus = await guestFrom(banned, "Linus Torvalds");
    const { user: linusUser } = (await linus.json()) as { user: Me };
    // The Workspace has answered that the address isn't banned.
    expect((await guestFrom(banned)).status).toBe(201);

    await ban(administrator, member.user.id);
    expect((await guestFrom(banned)).status).toBe(429);
    await ban(administrator, linusUser.id);
    await unban(administrator, member.user.id);
    expect((await guestFrom(banned)).status).toBe(429);
    await unban(administrator, linusUser.id);
    expect((await guestFrom(banned)).status).toBe(201);
  });

  it("doesn't keep an answer it read while a ban was being saved", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace(banned);
    let reading = false;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      // Forgets the answer it kept when Grace signed in, so it reads again.
      const object = workspace as unknown as { store: WorkspaceStore; knownBannedAddresses: Set<string> | null };
      object.knownBannedAddresses = null;
      const store = object.store;
      const bannedAddresses = store.bannedAddresses.bind(store);
      store.bannedAddresses = async () => {
        const addresses = await bannedAddresses();
        store.bannedAddresses = bannedAddresses;
        reading = true;
        await released;
        return addresses;
      };
    });

    const before = guestFrom(banned);
    await vi.waitFor(() => expect(reading).toBe(true));
    expect((await ban(administrator, member.user.id)).status).toBe(200);
    release();
    // Answered as though it came before the ban, which it did.
    expect((await before).status).toBe(201);
    expect((await guestFrom(banned)).status).toBe(429);
  });

  it("closes everyone's room sockets from an address it bans, so they connect again read-only, and again once it's lifted", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const graceThere = { ...(await signInAsGrace(banned)), ip: banned };
    const hal = { ...(await signIn("Hal")), ip: banned };
    const lobby = await freshRoom("lobby");
    const { id: dm } = await direct(administrator, hal);
    const linusElsewhere = await connect(lobby, { ...(await signIn("Linus Torvalds")), ip: "203.0.113.8" });
    const halsTabs = [await connect(lobby, hal), await connect(dm, hal)];
    const gracesTab = await connect(lobby, graceThere);
    const closes = halsTabs.map((tab) => closeOf(tab.ws));
    const gracesClose = closeOf(gracesTab.ws);

    await ban(administrator, member.user.id);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    // Her own tab closes for good.
    expect(await gracesClose).toMatchObject({ code: CloseCode.Revoked, reason: "Revoked" });
    const readOnly = await connect(lobby, hal);
    readOnly.send({ type: "message.create", clientMessageId: "refused", body: "Can I?" });
    expect(await readOnly.next("error")).toEqual({ type: "error", message: "Request failed (429)", clientMessageId: "refused", failed: "message.create" });

    const lifted = closeOf(readOnly.ws);
    await unban(administrator, member.user.id);
    expect(await lifted).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect((await post(await connect(lobby, hal), "I can")).body).toBe("I can");
    // A tab from elsewhere stayed open throughout.
    expect((await post(linusElsewhere, "Still here")).body).toBe("Still here");
  });

  it("lets a banned address's room sockets read, catch up and say they're typing, but refuses each change", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace(banned);
    const lobby = await freshRoom("lobby");
    const hal = { ...(await signIn("Hal")), ip: banned };
    const adaInLobby = await connect(lobby, administrator);
    const halInLobby = await connect(lobby, hal);
    const adas = await post(adaInLobby, "Ada's");
    const hals = await post(halInLobby, "Hal's", "hals");
    halInLobby.send({ type: "boost.create", messageId: adas.id, content: "🔥" });
    const { boost } = await halInLobby.next("boost.created");
    await adaInLobby.next("boost.created");
    const closed = closeOf(halInLobby.ws);
    await ban(administrator, member.user.id);
    await closed;

    const readOnly = await connect(lobby, hal);
    expect(readOnly.welcome.messages.map(({ id }) => id)).toEqual([adas.id, hals.id]);
    readOnly.send({ type: "message.create", clientMessageId: "refused", body: "Can I?" });
    readOnly.send({ type: "message.update", messageId: hals.id, body: "Edited" });
    readOnly.send({ type: "message.delete", messageId: hals.id });
    readOnly.send({ type: "boost.create", messageId: adas.id, content: "👍" });
    readOnly.send({ type: "boost.delete", boostId: boost.id });
    const refused = { type: "error", message: "Request failed (429)" };
    expect(await readOnly.next("error")).toEqual({ ...refused, clientMessageId: "refused", failed: "message.create" });
    for (const failed of ["message.update", "message.delete", "boost.create", "boost.delete"]) expect(await readOnly.next("error")).toEqual({ ...refused, failed });

    readOnly.send({ type: "typing.start" });
    expect(await adaInLobby.next("typing")).toEqual({ type: "typing", user: hal.user, typing: true });
    readOnly.send({ type: "history.before", before: hals.id });
    expect((await readOnly.next("history")).messages.map(({ id }) => id)).toEqual([adas.id]);
    readOnly.send({ type: "message.check", clientMessageIds: ["hals", "refused"] });
    expect(await readOnly.next("message.checked")).toEqual({ type: "message.checked", stored: ["hals"], missing: ["refused"] });
    const newer = await post(adaInLobby, "Ada's again");
    expect((await readOnly.next("message.created")).message.id).toBe(newer.id);

    await settle(readOnly, adaInLobby);
    expect(adaInLobby.pending("message.updated")).toEqual([]);
    expect(adaInLobby.pending("message.deleted")).toEqual([]);
    expect(adaInLobby.pending("boost.created")).toEqual([]);
    expect(adaInLobby.pending("boost.deleted")).toEqual([]);
    expect(await roomSql(lobby, "SELECT id, body FROM messages WHERE room_id = ? AND creator_id = ?", lobby, hal.user.id)).toEqual([{ id: hals.id, body: hals.body }]);
    expect(await roomSql(lobby, "SELECT id FROM boosts WHERE room_id = ?", lobby)).toEqual([{ id: boost.id }]);
  });

  it("takes a socket's address, and whether a ban blocks it, from the Worker, whatever the upgrade says", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace(banned);
    const lobby = await freshRoom("lobby");
    const hal = await signIn("Hal");
    await ban(administrator, member.user.id);
    // Once the rooms have closed the address's sockets, which would close this one too.
    await revoked();

    const spoofed = await api(`/api/rooms/${lobby}/socket?protocol=${ROOM_PROTOCOL}`, fromAddress(banned, hal, { headers: { ...upgrade().headers, [BANNED_HEADER]: "false" } }));
    const ws = spoofed.webSocket!;
    ws.accept();
    const frames: Array<{ type: string }> = [];
    ws.addEventListener("message", (event) => void frames.push(JSON.parse(event.data as string) as { type: string }));
    ws.send(JSON.stringify({ type: "message.create", clientMessageId: "refused", body: "Can I?" }));
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", message: "Request failed (429)", clientMessageId: "refused", failed: "message.create" }));
    const closed = closeOf(ws);
    ws.close(1000);
    await closed;

    // An address longer than any IP address tags nothing, so a header naming one can't either.
    const tagged = await api(
      `/api/rooms/${lobby}/socket?protocol=${ROOM_PROTOCOL}`,
      fromAddress("2001:db8::".padEnd(64, "1"), hal, { headers: { ...upgrade().headers, [ADDRESS_HEADER]: banned } }),
    );
    tagged.webSocket!.accept();
    const tags = await runInDurableObject(roomStub(lobby), (_room, state: DurableObjectState) =>
      state
        .getWebSockets()
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .map((socket) => state.getTags(socket)),
    );
    expect(tags).toEqual([[hal.user.id, expect.stringMatching(`^${sessionTag("")}`)]]);
  });

  it("queues closing the sockets from each address it blocks in every room, in the change that bans it, and in the one that lifts it", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await freshRoom("lobby");
    await direct(member, administrator);
    const rooms = ((await workspaceSql("SELECT id FROM rooms ORDER BY id")) as Array<{ id: string }>).map(({ id }) => id);
    const addresses = [banned, "2001:db8::7"];
    const queued = () => workspaceSql("SELECT room_id, tag, code, due_at FROM pending_revocations WHERE tag LIKE 'ip:%' ORDER BY room_id, tag");
    const expected = rooms.flatMap((room_id) => ["ip:2001:db8::7", "ip:203.0.113.7"].map((tag) => ({ room_id, tag, code: CloseCode.Reconnect, due_at: LATER })));
    const store = (workspace: Workspace) => (workspace as unknown as { store: WorkspaceStore }).store;

    const now = new Date().toISOString();
    expect(await runInDurableObject(workspaceStub(), (workspace: Workspace) => store(workspace).banPerson(member.user.id, addresses, CloseCode.Revoked, CloseCode.Reconnect, LATER, now))).toBe(true);
    expect(await queued()).toEqual(expected);
    await workspaceSql("DELETE FROM pending_revocations");
    expect(await runInDurableObject(workspaceStub(), (workspace: Workspace) => store(workspace).unbanPerson(member.user.id, CloseCode.Reconnect, LATER, now))).toBe(true);
    expect(await queued()).toEqual(expected);
  });

  it("turns away a socket let in from an address before the room heard it was banned, or that its ban was lifted", async () => {
    const room = await freshRoom("race");
    const { user } = await signIn("Hal");
    const revokedAt = Date.now();
    await roomStub(room).revoke(room, [{ tag: addressTag(banned), code: CloseCode.Reconnect }], revokedAt);
    const from = (address: string | undefined, authorizedAt: number): Access => ({ user, sessionId: "laptop", authorizedAt, address });
    const reconnect = { code: CloseCode.Reconnect, reason: "Reconnect" };

    expect(await outcome(room, from(banned, revokedAt - 1))).toEqual(reconnect);
    expect(await outcome(room, from(banned, revokedAt))).toEqual(reconnect);
    expect(await outcome(room, from(banned, revokedAt + 1))).toBe("welcome");
    expect(await outcome(room, from("203.0.113.8", revokedAt - 1))).toBe("welcome");
    expect(await outcome(room, from(undefined, revokedAt - 1))).toBe("welcome");
  });

  it("won't let an administrator ban someone signed in from the address they're using, which would block them too", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await signInAsGrace(banned);
    const lobby = await freshRoom("lobby");
    await post(await connect(lobby, member), "Still here");

    const response = await api(`/api/users/${member.user.id}/ban`, fromAddress(banned, administrator, { method: "POST" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "They signed in from your IP address, which a ban would block for you too" });
    expect(await stored(member.user.id)).toMatchObject({ status: 0 });
    expect(await sessionsOf(member.user.id)).toBe(2);
    expect(await workspaceSql("SELECT * FROM bans")).toEqual([]);
    expect(await workspaceSql("SELECT * FROM pending_purges")).toEqual([]);
    expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]);

    expect((await api(`/api/users/${member.user.id}/ban`, fromAddress("198.51.100.1", administrator, { method: "POST" }))).status).toBe(200);
  });

  it("finds whether a socket's address is banned by its index, as it looks up their membership", async () => {
    const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${ROOM_ACCESS}`, "room", "user", banned)).map((row) => (row as { detail: string }).detail);
    expect(plan).toContain("SEARCH memberships USING COVERING INDEX sqlite_autoindex_memberships_1 (room_id=? AND user_id=?)");
    expect(plan).toContain("SEARCH bans USING COVERING INDEX index_bans_on_ip_address (ip_address=?)");
  });
});

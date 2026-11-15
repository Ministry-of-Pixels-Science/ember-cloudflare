import { CloseCode, MAX_LISTED_USERS, type DirectRoom, type RoomId, type Sidebar, type User, type UserId, type WorkspaceServerFrame } from "@ember/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomEvent } from "../src/room-log";
import {
  api,
  closeOf,
  connect,
  createRoom,
  deactivatedPerson,
  direct,
  freshDeploy,
  listedRoom,
  openWorkspaceSocket,
  post,
  roomSql,
  signIn,
  startDirect,
  upgrade,
  workspaceSql,
  workspaceStub,
  type Session,
  type WorkspaceSocket,
} from "./support";

beforeEach(freshDeploy);

/** Everyone in a DM as it lists them: by id, with their names. */
const everyone = (...people: User[]) => people.map(({ id, name }) => ({ id, name })).sort((a, b) => (a.id < b.id ? -1 : 1));

const usersOf = (...sessions: Session[]) => sessions.map((session) => session.user);

/** The DM a start answered with. */
const startedRoom = async (response: Response) => ((await response.json()) as { room: DirectRoom }).room;

/** The sidebar `session`'s person gets. */
const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

/** The DMs `session`'s person sees listed, as the sidebar lists them. */
async function directsOf(session: Session) {
  return (await sidebarOf(session)).rooms.filter((room) => room.kind === "direct");
}

const membershipsOf = (roomId: RoomId) => workspaceSql("SELECT user_id, involvement FROM memberships WHERE room_id = ? ORDER BY user_id", roomId);

const directCount = async () => ((await workspaceSql("SELECT count(*) AS n FROM rooms WHERE kind = 'direct'")) as Array<{ n: number }>)[0]!.n;

const heardNothing = async (tab: WorkspaceSocket) => expect(await tab.answers()).toBe(true);

/** Waits for the Workspace to deliver every revocation it queued, which the rooms have finished with by then. */
const delivered = () => vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]), { timeout: 5_000 });

const remove = (roomId: RoomId, session: Session) => api(`/api/rooms/${roomId}`, { method: "DELETE", headers: { Cookie: session.cookie } });

/** What becomes of a new socket into a room as `session`'s person: let in, or the code it's closed with at once. */
async function opened(roomId: RoomId, session: Session): Promise<"welcome" | number> {
  const ws = (await api(`/api/rooms/${roomId}/socket`, upgrade(session.cookie))).webSocket!;
  ws.accept();
  return new Promise((resolve) => {
    ws.addEventListener("message", () => {
      resolve("welcome");
      ws.close(1000);
    });
    ws.addEventListener("close", (event) => resolve(event.code));
  });
}

describe("Start or reopen a direct message", () => {
  it("starts a DM between you and the people named, answering 201 with everyone in it, at the everything level", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const response = await startDirect(ada, [grace.user.id, linus.user.id]);
    expect(response.status).toBe(201);
    const room = await startedRoom(response);
    expect(room).toEqual({ id: expect.any(String), kind: "direct", members: everyone(...usersOf(ada, grace, linus)), activeAt: expect.any(String) });
    // Active as it starts, which lists it first.
    expect(Date.now() - Date.parse(room.activeAt)).toBeLessThan(60_000);
    expect(await membershipsOf(room.id)).toEqual(everyone(...usersOf(ada, grace, linus)).map(({ id }) => ({ user_id: id, involvement: "everything" })));
  });

  it("opens the DM a group has, answering 200, whoever in it starts it, in whatever order they're named", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await direct(ada, grace, linus);
    const again: Array<[Session, UserId[]]> = [
      [grace, [linus.user.id, ada.user.id]],
      [linus, [ada.user.id, grace.user.id, ada.user.id, linus.user.id]],
    ];
    for (const [as, userIds] of again) {
      const response = await startDirect(as, userIds);
      expect(response.status).toBe(200);
      expect(await startedRoom(response)).toEqual(room);
    }
    // Another group has another DM.
    expect((await direct(ada, grace)).id).not.toBe(room.id);
    expect(await directCount()).toBe(2);
  });

  it("starts your DM with yourself when it names nobody else, or nobody who exists", async () => {
    const ada = await signIn("Ada");
    const response = await api("/api/directs", { method: "POST", headers: { Cookie: ada.cookie }, body: "{}" });
    expect(response.status).toBe(201);
    const room = await startedRoom(response);
    expect(room.members).toEqual(everyone(ada.user));
    for (const userIds of [[], [ada.user.id], ["nobody"]]) expect(await startedRoom(await startDirect(ada, userIds))).toEqual(room);
    expect(await directCount()).toBe(1);
  });

  it("puts in anyone named who exists, whatever their status", async () => {
    const ada = await signIn("Ada");
    const former = await deactivatedPerson("Former");
    const room = await startedRoom(await startDirect(ada, [former, "nobody"]));
    expect(room.members).toEqual(everyone(ada.user, { id: former, name: "Former" }));
  });

  it("makes one DM between two requests that start the same one at once", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const responses = await Promise.all([startDirect(ada, [grace.user.id]), startDirect(grace, [ada.user.id])]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const [first, second] = await Promise.all(responses.map(startedRoom));
    expect(first).toEqual(second);
    expect(await directCount()).toBe(1);
    expect(await membershipsOf(first!.id)).toHaveLength(2);
  });

  it("lists a new DM in its members' sidebars, telling each of their tabs at once, and nobody else", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];
    const room = await direct(ada, grace);
    for (const tab of [adasTab, gracesTab]) expect(await tab.next()).toEqual({ type: "room.saved", room });
    await heardNothing(linussTab);

    // Opening it again changes nothing, so nobody hears of it.
    await direct(grace, ada);
    for (const tab of [adasTab, gracesTab]) await heardNothing(tab);
    for (const member of [ada, grace]) expect(await directsOf(member)).toEqual([listedRoom(room)]);
    expect(await directsOf(linus)).toEqual([]);
  });

  it("lets its members into its room, to talk there, and nobody else", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await direct(ada, grace);
    const [adaInIt, graceInIt] = [await connect(room.id, ada), await connect(room.id, grace)];
    const message = await post(adaInIt, "Hello, Grace");
    expect(await graceInIt.next("message.created")).toMatchObject({ message: { id: message.id, body: "Hello, Grace" } });
    expect(await opened(room.id, linus)).toBe(CloseCode.NotFound);
  });

  it("asks who's signed in, refuses other sites, and refuses anything but a list of people's ids", async () => {
    const ada = await signIn("Ada");
    expect((await api("/api/directs", { method: "POST", body: JSON.stringify({ userIds: [] }) })).status).toBe(401);
    const crossSite = await api("/api/directs", { method: "POST", headers: { Cookie: ada.cookie, Origin: "https://evil.test" }, body: JSON.stringify({ userIds: [] }) });
    expect(crossSite.status).toBe(422);

    for (const userIds of ["ada", [7], null]) {
      const refused = await startDirect(ada, userIds);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: `People must be a list of at most ${MAX_LISTED_USERS} user ids` });
    }
    expect((await api("/api/directs", { method: "POST", headers: { Cookie: ada.cookie }, body: "userIds=" })).status).toBe(422);
    expect(await directCount()).toBe(0);
  });
});

/** Waits until room `room` has nothing left in its log, which it forgets once the Workspace has applied it. */
async function applied(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM room_events WHERE room_id = ?", room)).length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * What `tab` has heard, once the Workspace has applied everything room `room` has logged, if given: the
 * frames that come before a pong.
 */
async function heard(tab: WorkspaceSocket, room?: RoomId): Promise<WorkspaceServerFrame[]> {
  if (room) await applied(room);
  tab.send(JSON.stringify({ type: "ping", nonce: crypto.randomUUID() }));
  const frames: WorkspaceServerFrame[] = [];
  for (let frame = await tab.next(); frame.type !== "pong"; frame = await tab.next()) frames.push(frame);
  return frames;
}

const lastMessageAt = async (roomId: RoomId) => ((await workspaceSql("SELECT last_message_at FROM rooms WHERE id = ?", roomId))[0] as { last_message_at: string | null }).last_message_at;

describe("DM order", () => {
  it("lists a DM as active when it started until a message comes, then when its latest came, telling everyone in it at once, its author too", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await direct(ada, grace);
    expect((await directsOf(grace)).map((listed) => listed.activeAt)).toEqual([room.activeAt]);
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    const message = await post(await connect(room.id, ada, { visible: true }), "Hello, Grace");
    const active = { type: "room.active", roomId: room.id, at: message.createdAt };
    expect(await heard(adasTab, room.id)).toEqual([active]);
    expect(await heard(gracesTab, room.id)).toEqual([{ type: "room.unread", roomId: room.id, at: expect.any(String) }, active]);
    expect(await heard(linussTab, room.id)).toEqual([]);
    for (const member of [ada, grace]) expect((await directsOf(member)).map((listed) => listed.activeAt)).toEqual([message.createdAt]);
  });

  it("moves a DM once for all the messages one call from its room brings, and never again for those applied before", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await direct(ada, grace);
    const tab = await openWorkspaceSocket(grace);
    const apply = (...events: RoomEvent[]) => workspaceStub().applyRoomEvents(room.id, events, []);
    const first: RoomEvent = { seq: 1, kind: "message", userId: ada.user.id, at: "2099-01-01T12:00:00.000Z" };
    const second: RoomEvent = { seq: 2, kind: "message", userId: ada.user.id, at: "2099-01-01T12:00:01.000Z" };
    const reading: RoomEvent = { seq: 3, kind: "read", userId: grace.user.id, at: "2099-01-01T12:00:02.000Z" };

    await apply(first, second);
    expect(await heard(tab)).toEqual([
      { type: "room.unread", roomId: room.id, at: expect.any(String) },
      { type: "room.active", roomId: room.id, at: second.at },
    ]);
    // Sent again, as after a call whose answer was lost, they move nothing, and a read moves nothing either.
    await apply(first, second);
    await apply(reading);
    expect(await heard(tab)).toEqual([{ type: "room.read", roomId: room.id }]);
    expect(await lastMessageAt(room.id)).toBe(second.at);
  });

  it("keeps the latest message's time when one from a clock behind comes after it, in a later call or the same one", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const [later, together] = [await direct(ada, grace), await direct(ada, linus)];
    const [ahead, behind] = ["2099-01-01T12:00:01.000Z", "2099-01-01T12:00:00.000Z"];
    const apply = (room: DirectRoom, ...events: RoomEvent[]) => workspaceStub().applyRoomEvents(room.id, events, []);
    await apply(later, { seq: 1, kind: "message", userId: ada.user.id, at: ahead });
    await apply(later, { seq: 2, kind: "message", userId: grace.user.id, at: behind });
    expect(await lastMessageAt(later.id)).toBe(ahead);

    const tab = await openWorkspaceSocket(linus);
    await apply(together, { seq: 1, kind: "message", userId: ada.user.id, at: ahead }, { seq: 2, kind: "message", userId: linus.user.id, at: behind });
    expect(await lastMessageAt(together.id)).toBe(ahead);
    expect(await heard(tab)).toEqual([
      { type: "room.unread", roomId: together.id, at: expect.any(String) },
      { type: "room.active", roomId: together.id, at: ahead },
    ]);
  });

  it("tells nobody when a message comes in a room that isn't a DM", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Design", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const tab = await openWorkspaceSocket(ada);
    await post(await connect(room.id, ada, { visible: true }), "Hello, room");
    expect(await heard(tab, room.id)).toEqual([]);
  });
});

describe("DMs in the sidebar", () => {
  it("lists only the DMs someone is in, never anyone they could start one with, as the people who join", async () => {
    const ada = await signIn("Ada");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const sidebar = await sidebarOf(ada);
    expect(sidebar.rooms.filter((room) => room.kind === "direct")).toEqual([]);
    expect(Object.keys(sidebar).sort()).toEqual(["favorites", "huddles", "invitation", "rooms", "sharedOrder"]);
    const room = await direct(grace, ada);
    expect(await directsOf(ada)).toEqual([listedRoom({ ...room, members: everyone(ada.user, grace.user) })]);
    expect(await directsOf(linus)).toEqual([]);
  });
});

describe("Group DMs and DM names", () => {
  it("lists everyone in each DM with the names they have now", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await direct(ada, grace);
    await workspaceSql("UPDATE users SET name = 'Grace Hopper' WHERE id = ?", grace.user.id);
    expect(await directsOf(ada)).toEqual([listedRoom({ ...room, members: everyone(ada.user, { ...grace.user, name: "Grace Hopper" }) })]);
  });
});

describe("Delete a direct message", () => {
  it("deletes a DM for any of its members, closing its sockets, and takes it out of their sidebars alone", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const room = await direct(ada, grace);
    const closed = closeOf((await connect(room.id, ada)).ws);
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    // Grace didn't start it.
    expect((await remove(room.id, grace)).status).toBe(204);
    expect(await closed).toMatchObject({ code: CloseCode.NotFound });
    for (const tab of [adasTab, gracesTab]) expect(await tab.next()).toEqual({ type: "room.gone", roomId: room.id });
    await heardNothing(linussTab);
    for (const member of [ada, grace]) expect(await directsOf(member)).toEqual([]);
    expect(await membershipsOf(room.id)).toEqual([]);

    // Starting it again makes another.
    expect((await direct(grace, ada)).id).not.toBe(room.id);
    await delivered();
  });

  it("answers 404 to people who aren't in it, administrators included", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", linus.user.id);
    const room = await direct(ada, grace);
    const response = await remove(room.id, linus);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Room not found or inaccessible" });
    expect(await directCount()).toBe(1);
  });
});

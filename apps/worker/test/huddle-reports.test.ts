import { CloseCode, type RoomId, type Sidebar, type UserId, type WorkspaceServerFrame } from "@ember/protocol";
import { HuddleCloseCode, type LiveHuddle } from "@ember/protocol/huddles";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { workspace } from "../src/workspace";
import { MEMBERS_TO_TELL_OF_HUDDLE } from "../src/workspace-store";
import { alarmOf, giveKeys, huddlesOn, joinHuddle, kept, OTHER_APP, ring, welcomed } from "./huddle-support";
import { api, createRoom, freshDeploy, freshRoom, openWorkspaceSocket, roomStub, sharedD1, signIn, workspaceSql, workspaceStub, type Session, type WorkspaceSocket } from "./support";

// Who's in a room's huddle, as the room tells the Workspace, and the Workspace everyone in the room, in
// the huddle or not: in their sidebars, and on their workspace sockets as it changes.

/** What a tab of someone in room `roomId` hears of its huddle. */
const told = (roomId: RoomId, huddle: LiveHuddle | null): WorkspaceServerFrame => ({ type: "room.huddle", roomId, huddle });

/** Expects the Workspace to have sent `tab` nothing but the answer to a ping sent now. */
const heardNothing = async (tab: WorkspaceSocket) => expect(await tab.answers()).toBe(true);

/** The next thing `tab` hears of a room's huddle, past whatever else it hears first. */
async function nextHuddle(tab: WorkspaceSocket): Promise<WorkspaceServerFrame> {
  for (;;) {
    const frame = await tab.next();
    if (frame.type === "room.huddle") return frame;
  }
}

const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

const change = (roomId: RoomId, session: Session, body: unknown) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });

/** A room's huddle, as its room's object holds it, with the bindings it reaches the Workspace through. */
const huddleOf = (room: ChatRoom) => (room as unknown as { huddle: { env: Env } }).huddle;

/**
 * Has the reports of room `room`'s huddle fail to reach the Workspace, as while the Workspace restarts,
 * until the function this answers is called. Whatever else the huddle asks the Workspace is answered.
 */
async function unreported(room: RoomId): Promise<() => Promise<void>> {
  let original: Env | undefined;
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const huddle = huddleOf(instance);
    original = huddle.env;
    const reached = workspace(original);
    const cutOff = { huddleApp: () => reached.huddleApp(), reportHuddle: () => Promise.reject(new Error("The Workspace is unreachable")) };
    huddle.env = { ...original, WORKSPACE: { getByName: () => cutOff } as unknown as Env["WORKSPACE"] };
  });
  return () => runInDurableObject(roomStub(room), (instance: ChatRoom) => void (huddleOf(instance).env = original!));
}

/** Counts how often a room fails to tell the Workspace who's in its huddle, from now on, by what it logs of it. */
function countFailures(): () => number {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warned.mock.calls.filter(([message]) => message === "Telling the Workspace who's in a huddle failed:").length;
}

/** How many rows the Workspace's database reads to answer `query`. */
async function rowsRead(query: string, ...params: Array<string | number>): Promise<number> {
  const db = sharedD1();
  if (db)
    return (
      await db
        .prepare(query)
        .bind(...params)
        .all()
    ).meta.rows_read;
  return runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => {
    const cursor = state.storage.sql.exec(query, ...params);
    cursor.toArray();
    return cursor.rowsRead;
  });
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Who's in a room's huddle, for the rest of the room", () => {
  it("tells everyone in the room who's in its huddle as people join and leave, in the huddle or not, and nobody else", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = (await createRoom("Plans", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];
    const heard = async (huddle: LiveHuddle | null) => {
      for (const tab of [adasTab, gracesTab]) expect(await tab.next()).toEqual(told(room, huddle));
    };

    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    await heard({ startedAt, userIds: [ada.user.id] });
    const graces = await welcomed(room, grace, true);
    await heard({ startedAt, userIds: [ada.user.id, grace.user.id] });

    // Who's muted is for the people in the huddle, and someone who moves to another tab is in it still.
    graces.send({ type: "huddle.mute", muted: false });
    await adas.next("huddle.changed");
    const moved = await welcomed(room, ada);
    expect(await adas.closed).toMatchObject({ code: HuddleCloseCode.Moved });
    for (const tab of [adasTab, gracesTab]) await heardNothing(tab);

    moved.leave();
    await heard({ startedAt, userIds: [grace.user.id] });
    graces.leave();
    await heard(null);
    await heardNothing(linussTab);
    expect(await alarmOf(room)).not.toBeNull();
    await ring(room);
    expect(await alarmOf(room)).toBeNull();
  });

  it("lists the huddles going on in someone's rooms in their sidebar, and none that's over", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const plans = (await createRoom("Plans", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const lobby = await freshRoom("lobby");
    const adasTab = await openWorkspaceSocket(ada);
    expect((await sidebarOf(ada)).huddles).toEqual({});

    const inPlans = await joinHuddle(plans, ada);
    const plansHuddle = { startedAt: (await inPlans.next("huddle.welcome")).startedAt, userIds: [ada.user.id] };
    expect(await adasTab.next()).toEqual(told(plans, plansHuddle));
    const inLobby = await joinHuddle(lobby, grace);
    const lobbyHuddle = { startedAt: (await inLobby.next("huddle.welcome")).startedAt, userIds: [grace.user.id] };
    expect(await adasTab.next()).toEqual(told(lobby, lobbyHuddle));

    for (const session of [ada, grace]) expect((await sidebarOf(session)).huddles).toEqual({ [plans]: plansHuddle, [lobby]: lobbyHuddle });
    // Nobody hears of a huddle in a room they aren't in.
    expect((await sidebarOf(linus)).huddles).toEqual({ [lobby]: lobbyHuddle });

    inPlans.leave();
    expect(await adasTab.next()).toEqual(told(plans, null));
    expect((await sidebarOf(ada)).huddles).toEqual({ [lobby]: lobbyHuddle });
  });

  it("tells whoever a change puts in a room of the huddle going on there", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await createRoom("Plans", { closedTo: [ada.user.id], as: ada });
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];
    const adas = await joinHuddle(room.id, ada);
    const huddle = { startedAt: (await adas.next("huddle.welcome")).startedAt, userIds: [ada.user.id] };
    expect(await adasTab.next()).toEqual(told(room.id, huddle));

    expect((await change(room.id, ada, { kind: "closed", memberIds: [ada.user.id, linus.user.id] })).status).toBe(200);
    expect([await linussTab.next(), await linussTab.next()]).toEqual([{ type: "room.saved", room }, told(room.id, huddle)]);
    expect((await change(room.id, ada, { kind: "open" })).status).toBe(200);
    expect([await gracesTab.next(), await gracesTab.next()]).toEqual([{ type: "room.saved", room: { ...room, kind: "open" } }, told(room.id, huddle)]);
    // Whoever was in the room has heard of its huddle already.
    for (const tab of [adasTab, linussTab]) {
      expect(await tab.next()).toEqual({ type: "room.saved", room: { ...room, kind: "open" } });
      await heardNothing(tab);
    }
  });

  it("says who's left in a huddle when someone in it loses the room, and that it's over once huddles are turned off", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("leaving");
    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    const graces = await welcomed(room, grace);
    const adasTab = await openWorkspaceSocket(ada);

    expect((await change(room, ada, { kind: "closed", memberIds: [ada.user.id] })).status).toBe(200);
    expect(await graces.closed).toMatchObject({ code: CloseCode.Reconnect });
    expect(await nextHuddle(adasTab)).toEqual(told(room, { startedAt, userIds: [ada.user.id] }));

    expect((await api("/api/account/huddles", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    await ring(room);
    expect(await adas.closed).toMatchObject({ code: HuddleCloseCode.Off });
    expect(await nextHuddle(adasTab)).toEqual(told(room, null));
    expect((await sidebarOf(ada)).huddles).toEqual({});
  });

  it("says that a huddle goes on with whoever joins it once huddles run through another app, and never that it's over", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("another-app");
    const gracesTab = await openWorkspaceSocket(grace);
    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    expect(await nextHuddle(gracesTab)).toEqual(told(room, { startedAt, userIds: [ada.user.id] }));

    await giveKeys(ada, OTHER_APP);
    // The room goes by what the Workspace last said of the app for half a minute, unless it has restarted since.
    await evictDurableObject(roomStub(room));
    await welcomed(room, grace);
    expect(await nextHuddle(gracesTab)).toEqual(told(room, { startedAt, userIds: [grace.user.id] }));
    // Ada's tab connects again, as her socket's closing has it do.
    expect(await adas.closed).toMatchObject({ code: CloseCode.Reconnect });
    await welcomed(room, ada);
    expect(await nextHuddle(gracesTab)).toEqual(told(room, { startedAt, userIds: [grace.user.id, ada.user.id] }));
  });

  it("says who's in the huddle again at each check, which tells the room of whatever a report failed to", async () => {
    const { ada } = await huddlesOn();
    const failures = countFailures();
    const room = await freshRoom("unreported");
    const adasTab = await openWorkspaceSocket(ada);

    let reach = await unreported(room);
    const adas = await joinHuddle(room, ada);
    const huddle = { startedAt: (await adas.next("huddle.welcome")).startedAt, userIds: [ada.user.id] };
    await vi.waitFor(() => expect(failures()).toBe(1));
    await ring(room);
    expect(failures()).toBe(2);
    await heardNothing(adasTab);
    await reach();
    await ring(room);
    expect(await adasTab.next()).toEqual(told(room, huddle));
    // A check that finds the Workspace knows who's in the huddle tells nobody anything.
    await ring(room);
    await heardNothing(adasTab);

    // The huddle's end too, which the room's alarm comes back for until the Workspace has heard of it.
    reach = await unreported(room);
    adas.leave();
    await adas.closed;
    await vi.waitFor(() => expect(failures()).toBe(3));
    await ring(room);
    expect(failures()).toBe(4);
    expect([await kept(room, "huddleRoom"), await alarmOf(room)]).toEqual([room, expect.any(Number)]);
    await reach();
    await ring(room);
    expect(await adasTab.next()).toEqual(told(room, null));
    expect([await kept(room, "huddleRoom"), await alarmOf(room)]).toEqual([undefined, null]);
  });

  it("tells the room that a huddle is over though the room's object has started afresh since it failed to", async () => {
    const { ada } = await huddlesOn();
    const failures = countFailures();
    const room = await freshRoom("afresh");
    const adasTab = await openWorkspaceSocket(ada);
    const adas = await welcomed(room, ada);
    expect(await adasTab.next()).toMatchObject({ type: "room.huddle", huddle: { userIds: [ada.user.id] } });

    await unreported(room);
    adas.leave();
    await adas.closed;
    await vi.waitFor(() => expect(failures()).toBe(1));
    // An object that starts afresh remembers only what it stored: the room whose huddle the Workspace has heard of.
    await evictDurableObject(roomStub(room));
    await ring(room);
    expect(await adasTab.next()).toEqual(told(room, null));
    expect([await kept(room, "huddleRoom"), await alarmOf(room)]).toEqual([undefined, null]);
  });

  it("keeps a huddle over whose start the Workspace only hears of once everyone has left it", async () => {
    const { ada } = await huddlesOn();
    const failures = countFailures();
    const room = await freshRoom("missed");
    const adasTab = await openWorkspaceSocket(ada);

    // The report that Ada joined is lost on its way, and the one that she left isn't: the Workspace, which knew
    // of no huddle, has nothing to tell the room.
    const reach = await unreported(room);
    const adas = await joinHuddle(room, ada);
    const huddle = { startedAt: (await adas.next("huddle.welcome")).startedAt, userIds: [ada.user.id] };
    await vi.waitFor(() => expect(failures()).toBe(1));
    const lostBy = Date.now();
    await reach();
    adas.leave();
    await adas.closed;
    await vi.waitFor(async () => expect(await kept(room, "huddleRoom")).toBeUndefined());
    await heardNothing(adasTab);

    // The lost report was made before the one the Workspace heard, so arriving after it changes nothing: the
    // room has stopped checking a huddle with nobody in it, and would never say that it's over again.
    expect(await workspaceStub().reportHuddle(room, lostBy, huddle)).toBeGreaterThanOrEqual(lostBy);
    await heardNothing(adasTab);
    expect((await sidebarOf(ada)).huddles).toEqual({});
  });

  it("goes by a room's latest report, whatever order they arrive in, and has a room report again after one it was too late for", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("out-of-order");
    const adasTab = await openWorkspaceSocket(ada);
    const startedAt = "2026-11-10T09:00:00.000Z";
    const report = (at: number, userIds: UserId[] | null, roomId = room) => workspaceStub().reportHuddle(roomId, at, userIds && { startedAt, userIds });
    const reportedAt = async () => ((await workspaceSql(`SELECT huddle_reported_at AS at FROM rooms WHERE id = ?`, room)) as Array<{ at: number }>)[0]!.at;

    // That a huddle is over tells nobody anything when the Workspace never heard of it. Only the report's time is
    // kept, for the report it never heard, which changes nothing should it arrive after all.
    expect(await report(1000, null)).toBeNull();
    expect(await report(500, ["a"])).toBe(1000);
    await heardNothing(adasTab);
    expect([(await sidebarOf(ada)).huddles, await reportedAt()]).toEqual([{}, 1000]);
    expect(await report(2000, ["a"])).toBeNull();
    expect(await adasTab.next()).toEqual(told(room, { startedAt, userIds: ["a"] }));
    // A report made earlier than the one kept, or no later, counts for nothing, and answers when that one was made.
    expect(await report(1000, ["a", "b"])).toBe(2000);
    expect(await report(2000, ["b"])).toBe(2000);
    // One that says what's kept already tells nobody anything, but its time is kept, so one made before it that
    // arrives after it changes nothing either.
    expect(await report(3000, ["a"])).toBeNull();
    await heardNothing(adasTab);
    expect(await report(2500, ["b"])).toBe(3000);
    await heardNothing(adasTab);
    expect([(await sidebarOf(ada)).huddles, await reportedAt()]).toEqual([{ [room]: { startedAt, userIds: ["a"] } }, 3000]);

    // Nor does a report from before a huddle ended bring it back.
    expect(await report(4000, null)).toBeNull();
    expect(await adasTab.next()).toEqual(told(room, null));
    expect(await report(3500, ["a"])).toBe(4000);
    expect(await report(5000, null)).toBeNull();
    await heardNothing(adasTab);
    expect([(await sidebarOf(ada)).huddles, await reportedAt()]).toEqual([{}, 5000]);
    // And a huddle in a room that isn't there is nobody's to hear of.
    expect(await report(6000, ["a"], "no-such-room")).toBeNull();
    await heardNothing(adasTab);

    // A room whose clock is behind the report the Workspace keeps hears so, and says who's in its huddle again, after it.
    const ahead = Date.now() + 60_000;
    expect(await report(ahead, ["a"])).toBeNull();
    expect(await adasTab.next()).toEqual(told(room, { startedAt, userIds: ["a"] }));
    const adas = await joinHuddle(room, ada);
    const welcome = await adas.next("huddle.welcome");
    expect(await adasTab.next()).toEqual(told(room, { startedAt: welcome.startedAt, userIds: [ada.user.id] }));
    expect(await reportedAt()).toBe(ahead + 1);
  });

  it("forgets a deleted room's huddle", async () => {
    const { ada } = await huddlesOn();
    const room = (await createRoom("Short-lived", { as: ada })).id;
    const adasTab = await openWorkspaceSocket(ada);
    const adas = await welcomed(room, ada);
    expect(await adasTab.next()).toMatchObject({ type: "room.huddle", roomId: room });

    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    expect(await adas.closed).toMatchObject({ code: CloseCode.NotFound });
    expect(await adasTab.next()).toEqual({ type: "room.gone", roomId: room });
    // The room says that its huddle is over, which is nobody's to hear of now.
    await vi.waitFor(async () => expect(await kept(room, "huddleRoom")).toBeUndefined());
    await heardNothing(adasTab);
    expect((await sidebarOf(ada)).huddles).toEqual({});
  });

  it("reads who's in the room only for a report that changes who's in its huddle", async () => {
    const { ada } = await huddlesOn();
    for (const name of ["Grace", "Linus", "Margaret"]) await signIn(name);
    const room = await freshRoom("plans");
    expect(await workspaceStub().reportHuddle(room, 2000, { startedAt: "2026-11-10T09:00:00.000Z", userIds: [ada.user.id] })).toBeNull();
    const members = ((await workspaceSql(`SELECT count(*) AS members FROM memberships WHERE room_id = ?`, room)) as Array<{ members: number }>)[0]!.members;
    expect(members).toBeGreaterThanOrEqual(5);
    // The report kept is the one made at 2000, so that's the one whose room hears of it.
    expect(await rowsRead(MEMBERS_TO_TELL_OF_HUDDLE, room, 2000)).toBeGreaterThanOrEqual(members);
    expect(await rowsRead(MEMBERS_TO_TELL_OF_HUDDLE, room, 2001)).toBeLessThanOrEqual(2);
  });
});

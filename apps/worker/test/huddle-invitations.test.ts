import type { Involvement, RoomId, UserId, WorkspaceServerFrame } from "@ember/protocol";
import { INVITED_TOO_OFTEN, NOBODY_INVITED } from "@ember/protocol/huddles";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { INVITES_A_MINUTE } from "../src/huddles/room";
import { workspace } from "../src/workspace";
import { HUDDLE_INVITEES } from "../src/workspace-store";
import { huddlesOn, joinHuddle, reached, welcomed, type HuddleSocket } from "./huddle-support";
import { api, createRoom, direct, freshDeploy, openWorkspaceSocket, roomStub, sharedD1, signIn, workspaceSql, workspaceStub, type Session, type WorkspaceSocket } from "./support";

// Inviting people into a room's huddle: someone in it names them, the room has the Workspace tell
// each of them who's in the room, on every tab they have open, and an invitation answered in one of
// someone's tabs stops ringing in the rest.

/** What a tab of someone invited into room `roomId`'s huddle hears, `by` being who invites them. */
const invited = (roomId: RoomId, by: Session): WorkspaceServerFrame => ({ type: "huddle.invited", roomId, by: by.user.id });

const isOfAnInvitation = ({ type }: WorkspaceServerFrame) => type === "huddle.invited" || type === "huddle.answered";

/** The next thing `tab` hears of an invitation, past whatever else it hears first. */
async function nextOfAnInvitation(tab: WorkspaceSocket): Promise<WorkspaceServerFrame> {
  for (;;) {
    const frame = await tab.next();
    if (isOfAnInvitation(frame)) return frame;
  }
}

/** Expects `tab` to have heard of no invitation by the time the Workspace answers a ping sent now. */
async function heardOfNone(tab: WorkspaceSocket): Promise<void> {
  tab.send(JSON.stringify({ type: "ping", nonce: crypto.randomUUID() }));
  for (;;) {
    const frame = await tab.next();
    expect(isOfAnInvitation(frame), JSON.stringify(frame)).toBe(false);
    if (frame.type === "pong") return;
  }
}

/** Has `client` invite `people` into its huddle. */
const invite = (client: HuddleSocket, ...people: Array<Session | UserId>) => client.send({ type: "huddle.invite", userIds: people.map((person) => (typeof person === "string" ? person : person.user.id)) });

/** Gives `session`'s person `involvement` in room `roomId`, as their bell does. */
async function involve(session: Session, roomId: RoomId, involvement: Involvement): Promise<void> {
  const response = await api(`/api/rooms/${roomId}/involvement`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ involvement }) });
  expect(response.status).toBe(200);
}

const answer = (roomId: string, session?: Session) => api(`/api/rooms/${roomId}/huddle/invitation`, { method: "DELETE", headers: session ? { Cookie: session.cookie } : {} });

/** A room's huddle, as its room's object holds it, with the bindings it reaches the Workspace through. */
const huddleOf = (room: ChatRoom) => (room as unknown as { huddle: { env: Env } }).huddle;

/** Has room `room`'s invitations fail to reach the Workspace, as while the Workspace restarts. Whatever else its huddle asks the Workspace is answered. */
async function uninvitable(room: RoomId): Promise<void> {
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const huddle = huddleOf(instance);
    const reached = workspace(huddle.env);
    const cutOff = {
      huddleApp: () => reached.huddleApp(),
      reportHuddle: (...report: Parameters<typeof reached.reportHuddle>) => reached.reportHuddle(...report),
      inviteToHuddle: () => Promise.reject(new Error("The Workspace is unreachable")),
    };
    huddle.env = { ...huddle.env, WORKSPACE: { getByName: () => cutOff } as unknown as Env["WORKSPACE"] };
  });
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Inviting people into a huddle", () => {
  it("rings in every tab of whoever someone in a direct message's huddle invites, and in nobody else's", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const dm = (await direct(ada, grace)).id;
    const [adasTab, gracesTab, gracesOtherTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    const adas = await welcomed(dm, ada);
    invite(adas, grace);
    for (const tab of [gracesTab, gracesOtherTab]) expect(await nextOfAnInvitation(tab)).toEqual(invited(dm, ada));
    for (const tab of [adasTab, linussTab, gracesTab]) await heardOfNone(tab);

    // Again, as often as they're invited.
    invite(adas, grace);
    for (const tab of [gracesTab, gracesOtherTab]) expect(await nextOfAnInvitation(tab)).toEqual(invited(dm, ada));
  });

  it("reaches only the people in the room, and of those only whoever hears its mentions of them or more", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus, margaret, alan] = [await signIn("Grace"), await signIn("Linus"), await signIn("Margaret"), await signIn("Alan")];
    const room = (await createRoom("Plans", { closedTo: [ada.user.id, grace.user.id, linus.user.id, margaret.user.id], as: ada })).id;
    await involve(grace, room, "everything");
    await involve(linus, room, "nothing");
    await involve(margaret, room, "invisible");
    const adas = await welcomed(room, ada);
    const tabs = { grace: await openWorkspaceSocket(grace), linus: await openWorkspaceSocket(linus), margaret: await openWorkspaceSocket(margaret), alan: await openWorkspaceSocket(alan) };

    invite(adas, linus, margaret, alan, "nobody-at-all", grace);
    expect(await nextOfAnInvitation(tabs.grace)).toEqual(invited(room, ada));
    // Linus and Margaret have the room's notifications off, and Alan isn't in it.
    for (const tab of [tabs.linus, tabs.margaret, tabs.alan]) await heardOfNone(tab);

    // At @mentions, a room's starting level, an invitation rings as a mention of them would.
    await involve(linus, room, "mentions");
    invite(adas, linus);
    expect(await nextOfAnInvitation(tabs.linus)).toEqual(invited(room, ada));
    for (const tab of [tabs.grace, tabs.margaret, tabs.alan]) await heardOfNone(tab);
  });

  it("reaches nobody who can no longer sign in, though they're still in the direct message", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    const named = JSON.stringify([grace.user.id]);
    expect(await workspaceSql(HUDDLE_INVITEES, dm, named)).toEqual([{ user_id: grace.user.id }]);

    // Banning her closes her tabs, so nothing the Workspace sends shows it: only who it would tell does.
    expect((await api(`/api/users/${grace.user.id}/ban`, { method: "POST", headers: { Cookie: ada.cookie } })).status).toBe(200);
    expect(await workspaceSql(`SELECT user_id FROM memberships WHERE room_id = ? AND user_id = ?`, dm, grace.user.id)).toHaveLength(1);
    expect(await workspaceSql(HUDDLE_INVITEES, dm, named)).toEqual([]);
  });

  it("leaves out whoever is in the huddle already, and asks the Workspace nothing when that's everyone named", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = (await createRoom("Plans", { closedTo: [ada.user.id, grace.user.id, linus.user.id], as: ada })).id;
    const [adas, graces] = [await welcomed(room, ada), await welcomed(room, grace)];
    const [adasTab, gracesTab, linussTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    invite(graces, ada, linus, grace);
    expect(await nextOfAnInvitation(linussTab)).toEqual(invited(room, grace));
    for (const tab of [adasTab, gracesTab]) await heardOfNone(tab);

    await uninvitable(room);
    invite(adas, grace, ada);
    await reached(adas);
    expect(adas.pending("error")).toEqual([]);
  });

  it("tells a tab that nobody was invited when the Workspace couldn't be given its invitation", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    const adas = await welcomed(dm, ada);
    const gracesTab = await openWorkspaceSocket(grace);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await uninvitable(dm);

    invite(adas, grace);
    expect(await adas.next("error")).toEqual({ type: "error", message: NOBODY_INVITED, failed: "huddle.invite" });
    expect(warned).toHaveBeenCalledWith("Inviting people into a huddle failed:", "Error");
    await heardOfNone(gracesTab);
  });

  it("invites nobody more for a tab that has invited people as often as one may in a minute, until the minute is over", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    const adas = await welcomed(dm, ada);
    const gracesTab = await openWorkspaceSocket(grace);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });

    for (let nth = 0; nth < INVITES_A_MINUTE; nth++) invite(adas, grace);
    for (let nth = 0; nth < INVITES_A_MINUTE; nth++) expect(await nextOfAnInvitation(gracesTab)).toEqual(invited(dm, ada));
    invite(adas, grace);
    expect(await adas.next("error")).toEqual({ type: "error", message: INVITED_TOO_OFTEN, failed: "huddle.invite" });
    await heardOfNone(gracesTab);

    // Another tab of theirs, which the huddle moves to, has a minute of its own, and so has this one once its own is over.
    vi.setSystemTime(start + 59_999);
    invite(adas, grace);
    expect(await adas.next("error")).toMatchObject({ message: INVITED_TOO_OFTEN });
    vi.setSystemTime(start + 60_000);
    invite(adas, grace);
    expect(await nextOfAnInvitation(gracesTab)).toEqual(invited(dm, ada));
  });

  it("refuses an invitation that names nobody, or someone twice, or gives no list of them", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    const adas = await welcomed(dm, ada);
    const gracesTab = await openWorkspaceSocket(grace);

    for (const userIds of [[], [grace.user.id, grace.user.id], grace.user.id]) {
      adas.send({ type: "huddle.invite", userIds });
      expect(await adas.next("error")).toEqual({ type: "error", message: "Unrecognized frame" });
    }
    await heardOfNone(gracesTab);
  });

  it("reads only the people invited, however many are in the room", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    for (const name of ["Linus", "Margaret", "Alan", "Barbara", "Edsger"]) await signIn(name);
    const room = (await createRoom("Everyone")).id;
    const members = ((await workspaceSql(`SELECT count(*) AS members FROM memberships WHERE room_id = ?`, room)) as Array<{ members: number }>)[0]!.members;
    expect(members).toBeGreaterThanOrEqual(7);
    expect(await workspaceStub().inviteToHuddle(room, ada.user.id, [grace.user.id])).toBeUndefined();
    // Her membership and herself, and the list she's named in, which counts for two.
    expect(await rowsRead(HUDDLE_INVITEES, room, JSON.stringify([grace.user.id]))).toBeLessThanOrEqual(4);
  });
});

describe("Answering an invitation into a huddle", () => {
  it("stops it ringing in every tab of whoever answers it, and tells nobody else", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    const [adasTab, gracesTab, gracesOtherTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace), await openWorkspaceSocket(grace)];
    const adas = await welcomed(dm, ada);
    invite(adas, grace);
    for (const tab of [gracesTab, gracesOtherTab]) expect(await nextOfAnInvitation(tab)).toEqual(invited(dm, ada));

    const response = await answer(dm, grace);
    expect(response.status).toBe(204);
    for (const tab of [gracesTab, gracesOtherTab]) expect(await nextOfAnInvitation(tab)).toEqual({ type: "huddle.answered", roomId: dm });
    await heardOfNone(adasTab);
  });

  it("answers only someone signed in, about a room there could be", async () => {
    const { ada } = await huddlesOn();
    const dm = (await direct(ada, await signIn("Grace"))).id;
    expect((await answer(dm)).status).toBe(401);
    expect((await answer("not%20a%20room", ada)).status).toBe(404);
    expect((await api(`/api/rooms/${dm}/huddle/invitation`, { method: "POST", headers: { Cookie: ada.cookie } })).status).toBe(404);
  });
});

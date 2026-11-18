import type { Involvement, RoomId, UserId, WorkspaceServerFrame } from "@ember/protocol";
import { INVITED_TOO_OFTEN, NOBODY_INVITED } from "@ember/protocol/huddles";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { INVITES_A_MINUTE } from "../src/huddles/room";
import { VIEWING_TTL_MS } from "../src/viewing";
import { workspace, type Workspace } from "../src/workspace";
import { HUDDLE_INVITEES, INVITATION_PUSHES, type InvitationPush } from "../src/workspace-store";
import { huddlesOn, joinHuddle, reached, welcomed, type HuddleSocket } from "./huddle-support";
import {
  api,
  connect,
  createRoom,
  direct,
  freshDeploy,
  openWorkspaceSocket,
  pushBrowser,
  roomStub,
  sharedD1,
  signIn,
  withWorkspaceEnv,
  workspaceSql,
  workspaceStub,
  type PushBrowser,
  type Session,
  type WorkspaceSocket,
} from "./support";

// Inviting people into a room's huddle: someone in it names them, the room has the Workspace tell
// each of them who's in the room, on every tab they have open, and an invitation answered in one of
// someone's tabs stops ringing in the rest. Whoever of them has Ember in view nowhere is pushed the
// invitation too, on every browser where they turned notifications on.

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

const idOf = (person: Session | UserId) => (typeof person === "string" ? person : person.user.id);

/** Has `client` invite `people` into its huddle. */
const invite = (client: HuddleSocket, ...people: Array<Session | UserId>) => client.send({ type: "huddle.invite", userIds: people.map(idOf) });

/** Gives `session`'s person `involvement` in room `roomId`, as their bell does. */
async function involve(session: Session, roomId: RoomId, involvement: Involvement): Promise<void> {
  const response = await api(`/api/rooms/${roomId}/involvement`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ involvement }) });
  expect(response.status).toBe(200);
}

const answer = (roomId: string, session?: Session) => api(`/api/rooms/${roomId}/huddle/invitation`, { method: "DELETE", headers: session ? { Cookie: session.cookie } : {} });

/** A room's huddle, as its room's object holds it, with the bindings it reaches the Workspace through. */
const huddleOf = (room: ChatRoom) => (room as unknown as { huddle: { env: Env } }).huddle;

type Invitation = Parameters<Workspace["inviteToHuddle"]>;

/**
 * Has room `room`'s invitations answered by `inviteToHuddle` in the Workspace's place, which is handed
 * the Workspace's own way of answering one. Whatever else its huddle asks the Workspace is answered.
 */
async function invitingBy(room: RoomId, inviteToHuddle: (real: (...invitation: Invitation) => Promise<InvitationPush[]>, ...invitation: Invitation) => Promise<unknown>): Promise<void> {
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const huddle = huddleOf(instance);
    const real = workspace(huddle.env);
    const standIn = {
      huddleApp: () => real.huddleApp(),
      huddlesIn: (roomId: RoomId) => real.huddlesIn(roomId),
      reportHuddle: (...report: Parameters<typeof real.reportHuddle>) => real.reportHuddle(...report),
      inviteToHuddle: (...invitation: Invitation) => inviteToHuddle((...given) => real.inviteToHuddle(...given), ...invitation),
    };
    huddle.env = { ...huddle.env, WORKSPACE: { getByName: () => standIn } as unknown as Env["WORKSPACE"] };
  });
}

/** Has room `room`'s invitations fail to reach the Workspace, as while the Workspace restarts. */
const uninvitable = (room: RoomId) => invitingBy(room, () => Promise.reject(new Error("The Workspace is unreachable")));

/**
 * Has room `room`'s invitations reach the Workspace only once `answer` is called, waiting in the room's
 * own I/O context, where a promise of the test's can't be awaited, and `asked` waits until the room
 * has one to give it.
 */
async function waitingWorkspace(room: RoomId) {
  let [asked, answering] = [false, false];
  await invitingBy(room, async (real, ...invitation) => {
    asked = true;
    while (!answering) await new Promise((resolve) => setTimeout(resolve, 10));
    return real(...invitation);
  });
  return { asked: () => vi.waitFor(() => expect(asked).toBe(true)), answer: () => (answering = true) };
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

/** Chrome's push service, where `subscribe` saves each subscription. */
const PUSH_SERVICE = "https://fcm.googleapis.com/fcm/send/";

/** Saves a subscription for `session` at Chrome's push service, at `/fcm/send/<label>`, for `browser`'s keys. */
async function subscribe(session: Session, label: string, browser?: PushBrowser): Promise<string> {
  const { p256dh, auth } = browser ?? (await pushBrowser());
  const endpoint = `${PUSH_SERVICE}${label}`;
  const response = await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ endpoint, p256dhKey: p256dh, authKey: auth }) });
  expect(response.status, await response.clone().text()).toBe(204);
  return endpoint;
}

/** What the Workspace answers a room inviting `people` into its huddle, as `by` does: the pushes for the room to send. */
const pushesOf = (roomId: RoomId, by: Session, ...people: Array<Session | UserId>): Promise<InvitationPush[]> => workspaceStub().inviteToHuddle(roomId, by.user.id, people.map(idOf));

/** Where an invitation's pushes go, by the labels `subscribe` gave them. */
const labelsOf = (pushes: InvitationPush[]) => pushes.flatMap(({ deliveries }) => deliveries.map(({ endpoint }) => endpoint.split("/").at(-1)));

/** Has `tab` say whether it's shown, as a tab does when that changes, and waits until the Workspace has read it. */
async function show(tab: WorkspaceSocket, visible: boolean): Promise<void> {
  tab.send(JSON.stringify({ type: "presence.visible", visible }));
  // A ping with more than its type is answered by the Workspace itself, once it has read what came before it.
  tab.send(JSON.stringify({ type: "ping", nonce: crypto.randomUUID() }));
  while ((await tab.next()).type !== "pong");
}

/** Has the Workspace have last heard from each of `session`'s tabs `ms` ago, other than by their pings. */
const unheardFor = (session: Session, ms: number) =>
  runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => {
    for (const tab of state.getWebSockets(session.user.id)) tab.serializeAttachment({ ...(tab.deserializeAttachment() as object), heardAt: Date.now() - ms });
  });

/**
 * Stands in for every push service, beside the stand-in SFU, which is asked the rest: keeps what was
 * pushed where, and for how long, in the order it came, and answers each push with `status`.
 */
function pushServices(status: (endpoint: string) => number = () => 201) {
  const pushed: Array<{ endpoint: string; ttl: string | undefined; body: Uint8Array }> = [];
  const fetched = vi.mocked(globalThis.fetch);
  const otherwise = fetched.getMockImplementation()!;
  fetched.mockImplementation(async (input, init) => {
    const endpoint = input instanceof Request ? input.url : String(input);
    if (!endpoint.startsWith(PUSH_SERVICE)) return otherwise(input, init);
    pushed.push({ endpoint, ttl: (init!.headers as Record<string, string>).TTL, body: init!.body as Uint8Array });
    return new Response(null, { status: status(endpoint) });
  });
  return pushed;
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
    expect(await workspaceSql(HUDDLE_INVITEES, dm, named, ada.user.id)).toEqual([{ user_id: grace.user.id }]);

    // Banning her closes her tabs, so nothing the Workspace sends shows it: only who it would tell does.
    expect((await api(`/api/users/${grace.user.id}/ban`, { method: "POST", headers: { Cookie: ada.cookie } })).status).toBe(200);
    expect(await workspaceSql(`SELECT user_id FROM memberships WHERE room_id = ? AND user_id = ?`, dm, grace.user.id)).toHaveLength(1);
    expect(await workspaceSql(HUDDLE_INVITEES, dm, named, ada.user.id)).toEqual([]);
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

  it("leaves the huddle's message for whoever is invited, though nobody joins, and whoever invites them has left before the Workspace tells them", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    const [gracesTab, gracesRoom] = [await openWorkspaceSocket(grace), await connect(dm, grace)];
    const adas = await welcomed(dm, ada);
    const { message } = await gracesRoom.next("message.created");
    const waiting = await waitingWorkspace(dm);

    invite(adas, grace);
    await waiting.asked();
    adas.leave();
    await adas.closed;
    expect((await gracesRoom.next("message.updated")).message).toMatchObject({ id: message.id, huddle: { people: [ada.user] } });
    await heardOfNone(gracesTab);
    waiting.answer();
    expect(await nextOfAnInvitation(gracesTab)).toEqual(invited(dm, ada));
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
    expect(await workspaceStub().inviteToHuddle(room, ada.user.id, [grace.user.id])).toEqual([]);
    // Her membership and herself, and the list she's named in, which counts for two.
    expect(await rowsRead(HUDDLE_INVITEES, room, JSON.stringify([grace.user.id]), ada.user.id)).toBeLessThanOrEqual(4);
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

describe("Pushing an invitation into a huddle", () => {
  it("pushes an invitation to every browser of whoever it reaches who has Ember open nowhere, and to nobody who has it in view", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = (await createRoom("Launch", { closedTo: [ada.user.id, grace.user.id, linus.user.id], as: ada })).id;
    for (const [session, label] of [[linus, "linus"], [grace, "grace-phone"], [ada, "ada"], [grace, "grace-laptop"]] as const) await subscribe(session, label);
    const linussTab = await openWorkspaceSocket(linus, { visible: true });

    const pushes = await pushesOf(room, ada, linus, grace);
    expect(pushes).toHaveLength(1);
    expect(labelsOf(pushes)).toEqual(["grace-phone", "grace-laptop"]);
    expect(await nextOfAnInvitation(linussTab)).toEqual(invited(room, ada));

    // Once Linus closes his tab he's away too, and his push goes out first, in the order the subscriptions were saved.
    linussTab.ws.close(1000);
    await linussTab.closed;
    expect(labelsOf(await pushesOf(room, ada, linus, grace))).toEqual(["linus", "grace-phone", "grace-laptop"]);
  });

  it("counts as away someone whose tabs are all in the background, as their addresses say or they've said since, until one is shown", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace");

    // A tab in the background hears the invitation, to ring if it can, and she's pushed it as well.
    const behind = await openWorkspaceSocket(grace, { visible: false });
    expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);
    expect(await nextOfAnInvitation(behind)).toEqual(invited(dm, ada));

    // One tab in front is enough.
    const inFront = await openWorkspaceSocket(grace, { visible: true });
    expect(await pushesOf(dm, ada, grace)).toEqual([]);
    await show(inFront, false);
    expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);
    await show(inFront, true);
    expect(await pushesOf(dm, ada, grace)).toEqual([]);
    inFront.ws.close(1000);
    await inFront.closed;
    expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);
  });

  it("counts out a tab that hasn't said whether it's shown, as one open since before an update hasn't, though its pings come, until it says so", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace");
    // A socket the Workspace let in before it kept this has no attachment, and stays connected when the Workspace takes new code after hibernating.
    const letInBefore = await openWorkspaceSocket(grace, { visible: true });
    await runInDurableObject(workspaceStub(), (_workspace, state: DurableObjectState) => {
      for (const socket of state.getWebSockets(grace.user.id)) socket.serializeAttachment(null);
    });
    // And a tab still running the app from before it said opens its next socket at an address that says nothing.
    const unsaid = await openWorkspaceSocket(grace);
    for (const tab of [letInBefore, unsaid]) {
      tab.send('{"type":"ping"}');
      while ((await tab.next()).type !== "pong");
    }

    for (const tab of [letInBefore, unsaid]) {
      expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);
      expect(await nextOfAnInvitation(tab)).toEqual(invited(dm, ada));
      await show(tab, true);
      expect(await pushesOf(dm, ada, grace)).toEqual([]);
      await show(tab, false);
    }
  });

  it("counts a tab in front as away once the Workspace hasn't heard from it in a minute, which its word that it's shown and its pings put off", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace");
    const tab = await openWorkspaceSocket(grace, { visible: true });

    await unheardFor(grace, VIEWING_TTL_MS - 10_000);
    expect(await pushesOf(dm, ada, grace)).toEqual([]);
    await unheardFor(grace, VIEWING_TTL_MS + 1);
    expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);

    await show(tab, true);
    expect(await pushesOf(dm, ada, grace)).toEqual([]);
    await unheardFor(grace, VIEWING_TTL_MS + 1);
    expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);

    // The app's heartbeat, which the runtime answers without waking the Workspace.
    tab.send('{"type":"ping"}');
    while ((await tab.next()).type !== "pong");
    expect(await pushesOf(dm, ada, grace)).toEqual([]);
  });

  it("takes a tab's word on whether it's shown with nothing said back, refuses one that's neither yes nor no, and goes by what the tab last said", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace");
    const tab = await openWorkspaceSocket(grace, { visible: true });

    tab.send(JSON.stringify({ type: "presence.visible", visible: false }));
    expect(await tab.answers()).toBe(true);
    for (const visible of ["true", 1, null, undefined]) {
      tab.send(JSON.stringify({ type: "presence.visible", visible }));
      expect(await tab.next()).toEqual({ type: "error", message: "Unrecognized frame" });
    }
    expect(labelsOf(await pushesOf(dm, ada, grace))).toEqual(["grace"]);
  });

  it("counts out a tab the Workspace is closing, as when its session ends", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace");
    await openWorkspaceSocket(grace, { visible: true });

    const pushes = await runInDurableObject(workspaceStub(), (instance: Workspace, state: DurableObjectState) => {
      state.getWebSockets(grace.user.id)[0]!.close(4001, "Reconnect");
      return instance.inviteToHuddle(dm, ada.user.id, [grace.user.id]);
    });
    expect(labelsOf(pushes)).toEqual(["grace"]);
  });

  it("pushes nobody its invitation doesn't reach: nobody outside the room, with its notifications off, or who can no longer sign in", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus, margaret, alan, barbara] = [await signIn("Grace"), await signIn("Linus"), await signIn("Margaret"), await signIn("Alan"), await signIn("Barbara")];
    const room = (await createRoom("Launch", { closedTo: [ada.user.id, grace.user.id, linus.user.id, margaret.user.id, barbara.user.id], as: ada })).id;
    for (const session of [grace, linus, margaret, alan, barbara]) await subscribe(session, session.user.name.toLowerCase());
    await involve(grace, room, "everything");
    await involve(linus, room, "nothing");
    await involve(margaret, room, "invisible");
    expect((await api(`/api/users/${barbara.user.id}/ban`, { method: "POST", headers: { Cookie: ada.cookie } })).status).toBe(200);
    const named = [linus, margaret, alan, barbara, grace].map(idOf);

    expect(labelsOf(await pushesOf(room, ada, ...named, "nobody-at-all"))).toEqual(["grace"]);
    // Nor does the search for their subscriptions find them, should one of them leave the room, turn
    // its notifications off or be banned once the Workspace has read whom the invitation reaches.
    const found = (await workspaceSql(INVITATION_PUSHES, room, ada.user.id, JSON.stringify(named), 1)) as Array<{ endpoint: string }>;
    expect(found.map(({ endpoint }) => endpoint)).toEqual([`${PUSH_SERVICE}grace`]);

    // At @mentions, a room's starting level, an invitation is pushed as a mention of them would be.
    await involve(linus, room, "mentions");
    expect(labelsOf(await pushesOf(room, ada, ...named))).toEqual(["grace", "linus"]);
  });

  it("pushes no guest while EMBER_GUEST_SIGN_IN doesn't let guests stay signed in, though they keep their subscriptions", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = (await createRoom("Launch", { closedTo: [ada.user.id, grace.user.id, linus.user.id], as: ada })).id;
    await subscribe(ada, "ada");
    await subscribe(grace, "grace");

    await withWorkspaceEnv({ EMBER_GUEST_SIGN_IN: undefined }, async () => {
      expect(labelsOf(await pushesOf(room, linus, ada, grace))).toEqual(["ada"]);
    });
    expect(labelsOf(await pushesOf(room, linus, ada, grace))).toEqual(["ada", "grace"]);
  });

  it("pushes nothing while Web Push is off, though the invitation still reaches the tabs someone has open", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace");
    const behind = await openWorkspaceSocket(grace, { visible: false });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await withWorkspaceEnv({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, async () => {
      expect(await pushesOf(dm, ada, grace)).toEqual([]);
      expect(await nextOfAnInvitation(behind)).toEqual(invited(dm, ada));
    });
  });

  it("says who invites, and into which room's huddle unless it's a DM's, opens the room, and is kept a minute", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Launch", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const dm = (await direct(ada, grace)).id;
    const endpoint = await subscribe(grace, "grace");

    expect(await pushesOf(room, ada, grace)).toEqual([
      { payload: { title: "Ada Lovelace", body: "Invites you to a huddle in Launch", path: `/rooms/${room}` }, deliveries: [expect.objectContaining({ endpoint, badge: 0 })], ttl: 60 },
    ]);
    expect(await pushesOf(dm, ada, grace)).toEqual([expect.objectContaining({ payload: { title: "Ada Lovelace", body: "Invites you to a huddle", path: `/rooms/${dm}` }, ttl: 60 })]);
  });

  it("counts in each push's badge its person's conversations marked unread, which an invitation adds nothing to", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Launch", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const dm = (await direct(ada, grace)).id;
    await subscribe(grace, "grace-phone");
    await subscribe(grace, "grace-laptop");
    await workspaceSql("UPDATE memberships SET unread_at = ? WHERE user_id = ? AND room_id IN (?, ?)", new Date().toISOString(), grace.user.id, room, dm);

    for (const invitedInto of [room, dm, room]) expect((await pushesOf(invitedInto, ada, grace))[0]!.deliveries.map(({ badge }) => badge)).toEqual([2, 2]);
  });

  it("finds an invitation's pushes by the memberships', people's and subscriptions' keys, reading only the people invited, however many are in the room", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Everyone")).id;
    await subscribe(grace, "grace");
    for (let nth = 1; nth <= 15; nth++) await subscribe(await signIn(`Member ${nth}`), `member-${nth}`);
    const [{ members, hers }] = (await workspaceSql(
      `SELECT (SELECT count(*) FROM memberships WHERE room_id = ?1) AS members, (SELECT count(*) FROM memberships WHERE user_id = ?2) AS hers`,
      room,
      grace.user.id,
    )) as [{ members: number; hers: number }];
    expect(members).toBeGreaterThanOrEqual(18);
    // The room and whoever invites, the list Grace is named in, herself and her membership come to 7,
    // and her subscription to 3 and the conversations she's in, for its badge: nothing of the room's
    // other people.
    expect(await rowsRead(INVITATION_PUSHES, room, ada.user.id, JSON.stringify([grace.user.id]), 1)).toBeLessThanOrEqual(7 + 3 + hers);

    const plan = ((await workspaceSql(`EXPLAIN QUERY PLAN ${INVITATION_PUSHES}`, room, ada.user.id, "[]", 1)) as Array<{ detail: string }>).map(({ detail }) => detail).join("; ");
    expect(plan).toContain("index_push_subscriptions_on_user_id_and_endpoint (user_id=?)");
    expect(plan).not.toMatch(/SCAN (rooms|memberships|users|push_subscriptions|marked|inviters)\b/);
  });

  describe("through the room", () => {
    it("sends an invitation's pushes as someone in the huddle invites, each encrypted for its browser, for its push service to keep a minute", async () => {
      const { ada } = await huddlesOn();
      const pushed = pushServices();
      const grace = await signIn("Grace");
      const dm = (await direct(ada, grace)).id;
      const browsers = { phone: await pushBrowser(), laptop: await pushBrowser() };
      for (const [label, browser] of Object.entries(browsers)) await subscribe(grace, label, browser);
      const adas = await welcomed(dm, ada);

      invite(adas, grace);
      await vi.waitFor(() => expect(pushed).toHaveLength(2), { timeout: 5_000 });
      for (const [label, browser] of Object.entries(browsers)) {
        const { ttl, body } = pushed.find(({ endpoint }) => endpoint === `${PUSH_SERVICE}${label}`)!;
        expect(ttl).toBe("60");
        expect(JSON.parse(await browser.open(body))).toEqual({ title: "Ada Lovelace", options: { body: "Invites you to a huddle", icon: "/account/logo", data: { path: `/rooms/${dm}`, badge: 0 } } });
      }
    });

    it("forgets a subscription its push service says is gone and keeps one it couldn't reach, failing nothing for whoever invites or is invited", async () => {
      const { ada } = await huddlesOn();
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const pushed = pushServices((endpoint) => (endpoint.endsWith("/gone") ? 410 : 503));
      const grace = await signIn("Grace");
      const dm = (await direct(ada, grace)).id;
      const gone = await subscribe(grace, "gone");
      await subscribe(grace, "busy");
      const [{ id }] = (await workspaceSql("SELECT id FROM push_subscriptions WHERE endpoint = ?", gone)) as [{ id: number }];
      const behind = await openWorkspaceSocket(grace, { visible: false });
      const adas = await welcomed(dm, ada);

      invite(adas, grace);
      await vi.waitFor(async () => expect(await workspaceSql("SELECT endpoint FROM push_subscriptions")).toEqual([{ endpoint: `${PUSH_SERVICE}busy` }]), { timeout: 5_000 });
      expect(pushed).toHaveLength(2);
      expect(logs).toHaveBeenCalledWith(`Destroying push subscription: ${id}`);
      expect(await nextOfAnInvitation(behind)).toEqual(invited(dm, ada));
      await reached(adas);
      expect(adas.pending("error")).toEqual([]);
    });

    it("sends no pushes, and fails nothing for whoever invites, while the Workspace is still on the code from before it answered them", async () => {
      const { ada } = await huddlesOn();
      const pushed = pushServices();
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const grace = await signIn("Grace");
      const dm = (await direct(ada, grace)).id;
      await subscribe(grace, "grace");
      const behind = await openWorkspaceSocket(grace, { visible: false });
      const adas = await welcomed(dm, ada);
      // As that code did, for some minutes after an update: it tells the tabs of whoever is invited, and answers nothing.
      await invitingBy(dm, async (real, ...invitation) => void (await real(...invitation)));

      invite(adas, grace);
      expect(await nextOfAnInvitation(behind)).toEqual(invited(dm, ada));
      await reached(adas);
      expect(adas.pending("error")).toEqual([]);
      expect(warned).not.toHaveBeenCalled();
      expect(pushed).toEqual([]);
    });
  });
});

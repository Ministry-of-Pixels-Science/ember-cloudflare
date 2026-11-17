import { CloseCode, ROOM_PROTOCOL, type Me, type RoomId, type ServerFrame } from "@ember/protocol";
import { CAMERAS_FULL, CAMERAS_OFF, HUDDLE_FAILED, HuddleCloseCode, MAX_HUDDLE_CAMERAS, MAX_HUDDLE_PEOPLE, SCREENS_FULL, SCREENS_OFF, type HuddlePerson, type HuddleTrackKind } from "@ember/protocol/huddles";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUDDLE_HEADER, type ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { HUDDLE_CHECK_MS, HUDDLE_SILENT_MS, HUDDLE_TAG, NO_OFFER, PUBLICATION_SETTLES_MS, TOO_FAST, type Huddle, type HuddleAttachment } from "../src/huddles/room";
import { REVOCATIONS_KEPT_MS, sessionTag } from "../src/revocations";
import { MAX_ROOM_FRAME_SIZE } from "../src/sockets";
import { viewersOf } from "../src/viewing";
import { workspace } from "../src/workspace";
import {
  alarmOf,
  APP,
  forwardHuddle,
  giveKeys,
  huddlesOn,
  joinHuddle,
  kept,
  listen,
  OTHER_APP,
  publishCamera,
  publishMicrophone,
  publishScreen,
  reached,
  ring,
  setUp,
  switchCameras,
  switchScreens,
  watch,
  watchSmall,
  welcomed,
  type HuddleSocket,
  type StandInSfu,
} from "./huddle-support";
import { api, connect, createRoom, freshDeploy, freshRoom, post, roomStub, settle, signIn, startUpload, upgrade, workspaceSql, type Session } from "./support";

// A room's huddle: who's in it, and what the room asks of the Realtime SFU for them, which a stand-in
// answers (./huddle-support.ts). Nothing here carries sound: a session description is whatever a test
// says it is, and the stand-in passes it on.

/** Someone in a huddle as the others hear of them: unmuted, and not to be listened to yet, but for `changes`. */
const person = ({ user }: Session, changes: Partial<Omit<HuddlePerson, "user">> = {}): HuddlePerson => ({ user, muted: false, audio: false, video: false, screen: false, ...changes });

/** Publishes `client`'s microphone, answering the session the SFU carries it on. */
async function publishing(sfu: StandInSfu, client: HuddleSocket, sdp?: string): Promise<string> {
  await publishMicrophone(client, sdp);
  return sfu.publishers.at(-1)!;
}

/** Publishes `client`'s camera, answering the session the SFU carries it on. */
async function showing(sfu: StandInSfu, client: HuddleSocket, sdp?: string): Promise<string> {
  await publishCamera(client, sdp);
  return sfu.publishers.at(-1)!;
}

/** Publishes the screen `client` shares, answering the session the SFU carries it on. */
async function sharing(sfu: StandInSfu, client: HuddleSocket, sdp?: string): Promise<string> {
  await publishScreen(client, sdp);
  return sfu.publishers.at(-1)!;
}

/** The session the SFU started last. */
const newest = (sfu: StandInSfu) => [...sfu.sessions.keys()].at(-1)!;

/** The media sections the SFU closed on session `id`, in the order it was asked to. */
const closedOn = (sfu: StandInSfu, id: string) => sfu.sessions.get(id)!.closed;

/** What each of the room's huddle sockets that are open remembers, in the order their people joined. */
const remembered = (room: RoomId) =>
  runInDurableObject(roomStub(room), (_room, state: DurableObjectState) =>
    state
      .getWebSockets(HUDDLE_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => socket.deserializeAttachment() as HuddleAttachment)
      .sort((a, b) => a.joinedAt - b.joinedAt),
  );

/** Has the room check its huddle, as its alarm does, as if at `now`. */
const checkAt = (room: RoomId, now: number) => runInDurableObject(roomStub(room), (instance: ChatRoom) => (instance as unknown as { huddle: Huddle }).huddle.check(now));

/** Who the room counts as viewing it. */
const viewers = (room: RoomId) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => viewersOf(state).sort());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const microphone = (sdp: string) => ({ type: "huddle.publish", sdp, tracks: [{ mid: "0", kind: "audio" }] }) as const;
const camera = (sdp: string) => ({ type: "huddle.publish", sdp, tracks: [{ mid: "0", kind: "video" }] }) as const;
const screen = (sdp: string) => ({ type: "huddle.publish", sdp, tracks: [{ mid: "0", kind: "screen" }] }) as const;
/** As many people as `count`, let into `room`'s huddle as the Worker sends each on, and welcomed. */
async function crowd(room: RoomId, count: number): Promise<HuddleSocket[]> {
  const authorizedAt = Date.now();
  const sockets: HuddleSocket[] = [];
  for (let n = 0; n < count; n++) sockets.push(await forwardHuddle(room, { user: { id: `person-${n}`, name: `Person ${n}` }, sessionId: `session-${n}`, authorizedAt }));
  for (const socket of sockets) await socket.next("huddle.welcome");
  return sockets;
}
const failed = (frame: string, kind: HuddleTrackKind = "audio") => ({ type: "error", message: HUDDLE_FAILED, failed: frame, kind });
/** What a tab hears of a camera the room won't publish while an administrator has cameras off. */
const CAMERA_OFF = { type: "error", message: CAMERAS_OFF, failed: "huddle.publish", kind: "video", refused: true };
/** And of a screen, while one has screen sharing off. */
const SCREEN_OFF = { type: "error", message: SCREENS_OFF, failed: "huddle.publish", kind: "screen", refused: true };

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("A room's huddle", () => {
  it("lets the room's members in on a socket of their own, welcomes each with who's in it, and tells the others who joins and leaves", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("huddle");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];

    const adas = await joinHuddle(room, ada);
    const welcome = await adas.next("huddle.welcome");
    expect(welcome).toEqual({ type: "huddle.welcome", you: ada.user, people: [person(ada)], startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) as string, messageId: expect.stringMatching(/^[0-9a-z]{16}$/) as string });

    const graces = await joinHuddle(room, grace, { muted: true });
    expect(await graces.next("huddle.welcome")).toEqual({ type: "huddle.welcome", you: grace.user, people: [person(ada), person(grace, { muted: true })], startedAt: welcome.startedAt, messageId: welcome.messageId });
    expect(await adas.next("huddle.joined")).toEqual({ type: "huddle.joined", person: person(grace, { muted: true }) });

    graces.leave();
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    await graces.closed;
    // Being in a huddle, with nobody's microphone published, asks the SFU nothing.
    expect(sfu.asked).toEqual([]);

    // Once everyone has left, someone who wasn't in it starts another by joining (huddle-message.test.ts has who goes on with it).
    adas.leave();
    await adas.closed;
    await sleep(5);
    const next = await joinHuddle(room, linus);
    const again = await next.next("huddle.welcome");
    expect(again.people).toEqual([person(linus)]);
    expect(Date.parse(again.startedAt)).toBeGreaterThan(Date.parse(welcome.startedAt));
  });

  it("keeps its sockets apart from the room's own: neither hears the other's frames, and being in a huddle isn't being in the room", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("apart");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adaInRoom = await connect(room, ada, { visible: true });
    const gracesHuddle = await welcomed(room, grace);

    // Whoever opens the room finds Ada there and not Grace, who isn't viewing it either.
    const linusInRoom = await connect(room, linus, { visible: true });
    expect(linusInRoom.welcome.present.map(({ id }) => id).sort()).toEqual([ada.user.id, linus.user.id].sort());
    expect(await viewers(room)).toEqual([ada.user.id, linus.user.id].sort());

    await post(adaInRoom, "Hello");
    gracesHuddle.send({ type: "huddle.mute", muted: true });
    await reached(gracesHuddle);
    await settle(adaInRoom, linusInRoom);
    expect(gracesHuddle.log.map(({ type }) => type)).toEqual(["huddle.welcome", "pong"]);
    const heardInRoom = (log: ServerFrame[]) => log.map(({ type }) => type).filter((type) => type.startsWith("huddle") || type === "presence.left");
    expect(heardInRoom([...adaInRoom.log, ...linusInRoom.log])).toEqual([]);
    expect((await adaInRoom.next("presence.joined")).user).toEqual(linus.user);

    // Grace opens the room too and closes it again: she has left the room, though she's in its huddle still.
    const graceInRoom = await connect(room, grace);
    expect((await adaInRoom.next("presence.joined")).user).toEqual(grace.user);
    graceInRoom.close();
    expect(await adaInRoom.next("presence.left")).toEqual({ type: "presence.left", userId: grace.user.id });
    const adasHuddle = await joinHuddle(room, ada);
    expect((await adasHuddle.next("huddle.welcome")).people).toEqual([person(grace, { muted: true }), person(ada)]);

    // And leaving the huddle isn't leaving the room, for Ada, who has it open.
    adasHuddle.leave();
    expect(await gracesHuddle.next("huddle.left")).toEqual({ type: "huddle.left", userId: ada.user.id });
    await settle(adaInRoom, linusInRoom);
    for (const { log } of [adaInRoom, linusInRoom]) expect(heardInRoom(log)).toEqual(["presence.left"]);
  });

  it("moves someone who joins from another tab to it, closing the tab they were in and telling the others only that they changed", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("moving");
    const grace = await signIn("Grace");
    const phone = await welcomed(room, ada);
    const onPhone = await publishing(sfu, phone);
    const graces = await welcomed(room, grace);

    const laptop = await joinHuddle(room, ada, { muted: true });
    // In her place still, ahead of Grace, with nothing published from this tab yet.
    expect((await laptop.next("huddle.welcome")).people).toEqual([person(ada, { muted: true }), person(grace)]);
    expect(await phone.closed).toMatchObject({ code: HuddleCloseCode.Moved, reason: "Moved" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { muted: true }) });
    await reached(graces);
    expect(graces.log.map(({ type }) => type)).toEqual(["huddle.welcome", "huddle.changed", "pong"]);
    // The SFU stops taking what the tab she left published.
    await vi.waitFor(() => expect(closedOn(sfu, onPhone)).toEqual(["0"]));
    expect(await remembered(room)).toMatchObject([{ user: ada.user }, { user: grace.user }]);
  });

  it("has everyone connect again once huddles run through another app, to the huddle as it goes on with whoever joins then", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("another-app");
    const grace = await signIn("Grace");
    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");

    await giveKeys(ada, OTHER_APP);
    // The room goes by what the Workspace last said of the app for half a minute, unless it has restarted since.
    await evictDurableObject(roomStub(room));
    const graces = await joinHuddle(room, grace);
    const welcome = await graces.next("huddle.welcome");
    // Ada's tab connects again, to the huddle she was in, which goes on with Grace from when it started.
    expect(await adas.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(welcome.people).toEqual([person(grace)]);
    expect(welcome.startedAt).toBe(startedAt);
    expect((await remembered(room)).map(({ appId, startedAt }) => ({ appId, startedAt }))).toEqual([{ appId: OTHER_APP.appId, startedAt: welcome.startedAt }]);
  });

  it("takes fifty people, and closes the socket of whoever comes next with the code that says it's full", async () => {
    await huddlesOn();
    const room = await freshRoom("full");
    const authorizedAt = Date.now();
    const access = (n: number, sessionId = `session-${n}`) => ({ user: { id: `person-${n}`, name: `Person ${n}` }, sessionId, authorizedAt });
    const sockets: HuddleSocket[] = [];
    for (let n = 0; n < MAX_HUDDLE_PEOPLE; n++) sockets.push(await forwardHuddle(room, access(n)));
    expect((await sockets.at(-1)!.next("huddle.welcome")).people).toHaveLength(MAX_HUDDLE_PEOPLE);

    // Everyone in a full huddle can be heard by everyone else: what a socket remembers of 49 others fits it.
    for (const socket of sockets) await publishMicrophone(socket);
    for (const socket of [sockets[0]!, sockets.at(-1)!]) {
      const offer = await listen(socket, true);
      expect(new Set(offer!.tracks.map(({ userId }) => userId)).size).toBe(MAX_HUDDLE_PEOPLE - 1);
    }
    expect((await remembered(room))[0]!.receiving!.heard).toHaveLength(MAX_HUDDLE_PEOPLE - 1);
    expect(await listen(sockets[0]!)).toBeNull();

    const late = await forwardHuddle(room, access(MAX_HUDDLE_PEOPLE));
    expect(await late.closed).toMatchObject({ code: HuddleCloseCode.Full, reason: "Full" });
    // Nobody heard of them.
    await reached(sockets[0]!);
    expect(sockets[0]!.pending("huddle.joined")).toHaveLength(MAX_HUDDLE_PEOPLE - 1);

    // Someone in it still moves to another tab, and once someone leaves there's room for one more.
    const moved = await forwardHuddle(room, access(0, "another tab"));
    expect((await moved.next("huddle.welcome")).people).toHaveLength(MAX_HUDDLE_PEOPLE);
    sockets[1]!.leave();
    await moved.next("huddle.left");
    const next = await forwardHuddle(room, access(MAX_HUDDLE_PEOPLE));
    expect((await next.next("huddle.welcome")).people).toHaveLength(MAX_HUDDLE_PEOPLE);
  });

  it("closes the socket of whoever joins while huddles are off, with the code that says so", async () => {
    const ada = await setUp();
    const room = await freshRoom("off");
    const socket = await joinHuddle(room, ada);
    expect(await socket.closed).toMatchObject({ code: HuddleCloseCode.Off, reason: "Off" });
    expect(await alarmOf(room)).toBeNull();
  });

  it("tells the others when someone mutes their microphone, or unmutes it", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("muting");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada, true);
    const graces = await welcomed(room, grace);

    adas.send({ type: "huddle.mute", muted: false });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada) });
    // Said again, it's nothing new, and it takes a yes or no.
    adas.send({ type: "huddle.mute", muted: false });
    adas.send({ type: "huddle.mute", muted: "no" });
    expect(await adas.next("error")).toEqual({ type: "error", message: "Unrecognized frame" });
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);

    graces.send({ type: "huddle.mute", muted: true });
    expect(await adas.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(grace, { muted: true }) });
    const linuses = await joinHuddle(room, await signIn("Linus"));
    expect((await linuses.next("huddle.welcome")).people).toMatchObject([{ muted: false }, { muted: true }, { muted: false }]);
  });

  it("refuses a frame it can't read, and closes a socket that sends one larger than a room takes", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("frames");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const unreadable = [
      { type: "huddle.publish", sdp: "", tracks: [{ mid: "0", kind: "audio" }] },
      { type: "huddle.publish", sdp: "an offer", tracks: [] },
      { type: "huddle.publish", sdp: "an offer", tracks: [{ mid: "0#audio", kind: "audio" }] },
      { type: "huddle.publish", sdp: "an offer", tracks: [{ mid: "0", kind: "slides" }] },
      { type: "huddle.publish", sdp: "an offer", tracks: [{ mid: "0", kind: "audio" }, { mid: "1", kind: "video" }] },
      { type: "huddle.listen", fresh: "yes" },
      { type: "huddle.listen", kind: "slides" },
      { type: "huddle.listen", kind: "video", watch: "everyone" },
      { type: "huddle.listen", kind: "screen", watch: ["u1", "u2", "u3"] },
      { type: "huddle.unpublish", kind: "slides" },
      { type: "huddle.answer" },
      { type: "message.create", clientMessageId: "c1", body: "Hello" },
    ];
    for (const frame of unreadable) {
      graces.send(frame);
      expect(await graces.next("error"), JSON.stringify(frame)).toEqual({ type: "error", message: "Unrecognized frame" });
    }
    graces.sendRaw(new TextEncoder().encode(JSON.stringify(microphone("an offer"))).buffer as ArrayBuffer);
    expect(await graces.next("error")).toEqual({ type: "error", message: "Unrecognized frame" });
    expect(sfu.asked).toEqual([]);

    graces.sendRaw(JSON.stringify(microphone("an offer")).padEnd(MAX_ROOM_FRAME_SIZE + 1, " "));
    expect((await graces.closed).code).toBe(1009);
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    expect(sfu.asked).toEqual([]);
  });

  it("takes whoever sends a frame larger than a room takes out of the huddle as it closes their socket, though their tab never answers the close", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("too-large");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    await listen(graces, true);
    const toGrace = newest(sfu);
    // As when a tab never answers the close: the room hears nothing more of the socket.
    await runInDurableObject(roomStub(room), (instance: ChatRoom) => void vi.spyOn((instance as unknown as { huddle: Huddle }).huddle, "left").mockImplementation(() => {}));

    graces.sendRaw(" ".repeat(MAX_ROOM_FRAME_SIZE + 1));
    expect((await graces.closed).code).toBe(1009);
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    await vi.waitFor(() => expect([closedOn(sfu, fromGrace), closedOn(sfu, toGrace)]).toEqual([["0"], ["0"]]));
    expect(await remembered(room)).toMatchObject([{ user: ada.user }]);
  });
});

describe("What a huddle asks of the Realtime SFU", () => {
  it("publishes a tab's microphone on a session of its own, and has the others hear of it once its connection has connected", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("publishing");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);

    adas.send(microphone("Ada's offer"));
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "audio", sdp: "answer to Ada's offer" });
    const [session] = sfu.publishers;
    expect(sfu.asked).toEqual([
      { appId: APP.appId, method: "POST", path: "/sessions/new", body: null },
      {
        appId: APP.appId,
        method: "POST",
        path: `/sessions/${session}/tracks/new`,
        sessionId: session,
        body: { sessionDescription: { type: "offer", sdp: "Ada's offer" }, tracks: [{ location: "local", mid: "0", trackName: "audio" }] },
      },
    ]);
    // Nobody can listen to her until her tab says its connection has connected.
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);
    expect((await (await joinHuddle(room, await signIn("Linus"))).next("huddle.welcome")).people[0]).toEqual(person(ada));

    adas.send({ type: "huddle.connected" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true }) });
    // Said again, it's nothing new, and neither is it from a tab that publishes nothing.
    adas.send({ type: "huddle.connected" });
    graces.send({ type: "huddle.connected" });
    await reached(adas, graces);
    expect([...adas.pending("huddle.changed"), ...graces.pending("huddle.changed")]).toEqual([]);
    expect(sfu.asked).toHaveLength(2);
  });

  it("offers a tab everyone it can listen to, on a session of its own, and has it hear them once it answers", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("listening");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    const linuses = await welcomed(room, linus);
    sfu.asked.length = 0;

    linuses.send({ type: "huddle.listen", fresh: true });
    const offer = await linuses.next("huddle.offer");
    const toLinus = newest(sfu);
    expect(offer).toEqual({
      type: "huddle.offer",
      kind: "audio",
      sdp: expect.stringMatching(/^offer \d+$/) as string,
      tracks: [
        { mid: "0", kind: "audio", userId: ada.user.id },
        { mid: "1", kind: "audio", userId: grace.user.id },
      ],
    });
    linuses.send({ type: "huddle.answer", sdp: "Linus's answer" });
    expect(await linuses.next("huddle.listening")).toEqual({ type: "huddle.listening", kind: "audio" });
    expect(sfu.asked).toEqual([
      { appId: APP.appId, method: "POST", path: "/sessions/new", body: null },
      {
        appId: APP.appId,
        method: "POST",
        path: `/sessions/${toLinus}/tracks/new`,
        sessionId: toLinus,
        body: {
          tracks: [
            { location: "remote", sessionId: fromAda, trackName: "audio" },
            { location: "remote", sessionId: fromGrace, trackName: "audio" },
          ],
        },
      },
      { appId: APP.appId, method: "PUT", path: `/sessions/${toLinus}/renegotiate`, sessionId: toLinus, body: { sessionDescription: { type: "answer", sdp: "Linus's answer" } } },
    ]);
    expect(sfu.sessions.get(toLinus)!.answers).toEqual(["Linus's answer"]);

    // Asked again, with nobody new, the room asks the SFU nothing.
    expect(await listen(linuses)).toBeNull();
    expect(sfu.asked).toHaveLength(3);
    // Nobody is offered their own microphone.
    expect((await listen(adas, true))!.tracks).toEqual([{ mid: "0", kind: "audio", userId: grace.user.id }]);

    // A session's ID is all it takes to hear what it publishes, so none reaches a tab.
    const heard = JSON.stringify([adas.log, graces.log, linuses.log]);
    expect(sfu.sessions.size).toBe(4);
    for (const sessionId of sfu.sessions.keys()) expect(heard).not.toContain(sessionId);
    expect(heard).not.toContain(APP.appSecret);
  });

  it("offers a tab only those it doesn't hear yet, and nobody whose microphone hasn't connected", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("newcomers");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    await publishing(sfu, adas);
    const linuses = await welcomed(room, linus);
    expect((await listen(linuses, true))!.tracks).toEqual([{ mid: "0", kind: "audio", userId: ada.user.id }]);
    const toLinus = newest(sfu);

    const graces = await welcomed(room, grace);
    graces.send(microphone("Grace's offer"));
    await graces.next("huddle.published");
    const asked = sfu.asked.length;
    expect(await listen(linuses)).toBeNull();
    expect(sfu.asked).toHaveLength(asked);

    graces.send({ type: "huddle.connected" });
    expect(await linuses.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(grace, { audio: true }) });
    expect((await listen(linuses))!.tracks).toEqual([{ mid: "1", kind: "audio", userId: grace.user.id }]);
    // On the session it has: the room started it none.
    expect(sfu.asked.at(-2)).toMatchObject({ path: `/sessions/${toLinus}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: sfu.publishers[1], trackName: "audio" }] } });
    expect(sfu.asked.at(-1)).toMatchObject({ path: `/sessions/${toLinus}/renegotiate` });
    expect((await remembered(room))[1]!.receiving).toMatchObject({ sessionId: toLinus, heard: [{ mid: "0" }, { mid: "1" }] });
  });

  it("leaves a tab's offer to be answered before it's made another, and takes no answer to an offer it didn't make", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("answering");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    await publishing(sfu, adas);
    const graces = await welcomed(room, grace);

    graces.send({ type: "huddle.answer", sdp: "an answer to nothing" });
    expect(await graces.next("error")).toEqual({ type: "error", message: NO_OFFER });

    graces.send({ type: "huddle.listen", fresh: true });
    const offer = await graces.next("huddle.offer");
    const asked = sfu.asked.length;
    graces.send({ type: "huddle.listen" });
    await reached(graces);
    await sleep(20);
    expect([...graces.pending("huddle.offer"), ...graces.pending("huddle.listening"), ...graces.pending("error")]).toEqual([]);
    expect(sfu.asked).toHaveLength(asked);

    graces.send({ type: "huddle.answer", sdp: `answer to ${offer.sdp}` });
    expect(await graces.next("huddle.listening")).toEqual({ type: "huddle.listening", kind: "audio" });
    graces.send({ type: "huddle.answer", sdp: `answer to ${offer.sdp}` });
    expect(await graces.next("error")).toEqual({ type: "error", message: NO_OFFER });
    expect(sfu.askedTo(/renegotiate$/)).toHaveLength(1);
  });

  it("stops a tab hearing whoever left, or publishes anew, as it next asks to listen", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("stale");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    const linuses = await welcomed(room, linus);
    await listen(linuses, true);
    const toLinus = newest(sfu);

    graces.leave();
    expect(await linuses.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    await vi.waitFor(() => expect(closedOn(sfu, fromGrace)).toEqual(["0"]));
    expect(closedOn(sfu, toLinus)).toEqual([]);
    expect(await listen(linuses)).toBeNull();
    expect(closedOn(sfu, toLinus)).toEqual(["1"]);
    expect(sfu.askedTo(/tracks\/close$/).at(-1)).toEqual({ appId: APP.appId, method: "PUT", path: `/sessions/${toLinus}/tracks/close`, sessionId: toLinus, body: { tracks: [{ mid: "1" }], force: true } });

    // Ada's tab publishes again, from a new connection: nobody can listen to her until it has connected.
    adas.send(microphone("Ada's second offer"));
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "audio", sdp: "answer to Ada's second offer" });
    expect(await linuses.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada) });
    await vi.waitFor(() => expect(closedOn(sfu, fromAda)).toEqual(["0"]));
    expect(await listen(linuses)).toBeNull();
    expect(closedOn(sfu, toLinus)).toEqual(["1", "0"]);

    adas.send({ type: "huddle.connected" });
    expect(await linuses.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true }) });
    expect((await listen(linuses))!.tracks).toEqual([{ mid: "2", kind: "audio", userId: ada.user.id }]);
    expect(sfu.sessions.get(toLinus)!.pulled).toEqual(new Map([["2", { sessionId: sfu.publishers[2], trackName: "audio" }]]));
  });

  it("names nobody in an offer for what they published before, once they publish anew while the SFU makes it", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("anew-meanwhile");
    const linus = await signIn("Linus");
    const adas = await welcomed(room, ada);
    const fromAda = await publishing(sfu, adas);
    const linuses = await welcomed(room, linus);

    // The SFU is slow to offer Linus what Ada publishes, and to close it: she has published anew, and can be listened to again, before it answers.
    const offer = sfu.hold(/tracks\/new$/);
    const close = sfu.hold(new RegExp(`${fromAda}/tracks/close$`));
    linuses.send({ type: "huddle.listen", fresh: true });
    await vi.waitFor(() => expect(sfu.askedTo(/tracks\/new$/)).toHaveLength(2));
    const toLinus = newest(sfu);
    const fromAdaNow = await publishing(sfu, adas, "Ada's second offer");
    expect(await linuses.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada) });
    expect(await linuses.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true }) });

    // Named for that track, she'd be taken for heard, and never asked for again.
    offer();
    const outdated = await linuses.next("huddle.offer");
    expect(outdated.tracks).toEqual([]);
    expect(sfu.sessions.get(toLinus)!.pulled).toEqual(new Map([["0", { sessionId: fromAda, trackName: "audio" }]]));
    linuses.send({ type: "huddle.answer", sdp: `answer to ${outdated.sdp}` });
    await linuses.next("huddle.listening");
    close();

    // Asked again, as a tab does after an offer, the room has that track closed and offers what she publishes now.
    expect((await listen(linuses))!.tracks).toEqual([{ mid: "1", kind: "audio", userId: ada.user.id }]);
    expect(closedOn(sfu, toLinus)).toEqual(["0"]);
    expect(sfu.sessions.get(toLinus)!.pulled).toEqual(new Map([["1", { sessionId: fromAdaNow, trackName: "audio" }]]));
  });

  it("has the SFU close what a tab published and heard, and what it was offered, once it leaves", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("leaving");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    await listen(graces, true);
    const toGrace = newest(sfu);
    const linuses = await welcomed(room, linus);
    linuses.send({ type: "huddle.listen", fresh: true });
    await linuses.next("huddle.offer");
    const toLinus = newest(sfu);

    graces.leave();
    linuses.leave();
    await vi.waitFor(() => {
      expect(closedOn(sfu, fromGrace)).toEqual(["0"]);
      expect(closedOn(sfu, toGrace)).toEqual(["0"]);
      expect(closedOn(sfu, toLinus)).toEqual(["0", "1"]);
    });
    // Without their say, since their tabs may be gone, and nothing of Ada's.
    for (const { body } of sfu.askedTo(/tracks\/close$/)) expect(body).toMatchObject({ force: true });
    expect(closedOn(sfu, fromAda)).toEqual([]);
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
  });

  it("tells a tab when the SFU refuses what it asked, and lets go of a receiving connection it can no longer vouch for", async () => {
    const { ada, sfu } = await huddlesOn();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = await freshRoom("refused");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);

    // A microphone the SFU doesn't take isn't published.
    sfu.refuse(/tracks\/new$/);
    adas.send(microphone("Ada's offer"));
    expect(await adas.next("error")).toEqual(failed("huddle.publish"));
    expect(warned).toHaveBeenLastCalledWith("A huddle's huddle.publish failed:", "The Realtime SFU answered 500 (internal_error)");
    adas.send({ type: "huddle.connected" });
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);
    // Nor is one it can't be reached about.
    sfu.answerInstead(/sessions\/new$/, () => Promise.reject(new TypeError("Network connection lost")));
    adas.send(microphone("Ada's offer"));
    expect(await adas.next("error")).toEqual(failed("huddle.publish"));
    expect(warned).toHaveBeenLastCalledWith("A huddle's huddle.publish failed:", "The Realtime SFU answered nothing");
    await publishing(sfu, adas);

    // A tab the SFU refuses to offer anyone starts over: the room has the SFU close what it heard.
    expect((await listen(linuses, true))!.tracks).toHaveLength(1);
    const first = newest(sfu);
    await publishing(sfu, graces);
    sfu.refuse(/tracks\/new$/, 503, "temporarily_unavailable_error");
    linuses.send({ type: "huddle.listen" });
    expect(await linuses.next("error")).toEqual(failed("huddle.listen"));
    await vi.waitFor(() => expect(closedOn(sfu, first)).toEqual(["0"]));
    expect((await remembered(room))[2]!.receiving).toBeUndefined();

    // As does one whose answer the SFU refuses, with what it was offered.
    linuses.send({ type: "huddle.listen" });
    const offer = await linuses.next("huddle.offer");
    const second = newest(sfu);
    expect(second).not.toBe(first);
    expect(offer.tracks).toEqual([
      { mid: "0", kind: "audio", userId: ada.user.id },
      { mid: "1", kind: "audio", userId: grace.user.id },
    ]);
    sfu.refuse(/renegotiate$/, 406, "invalid_session_description");
    linuses.send({ type: "huddle.answer", sdp: "an answer the SFU can't take" });
    expect(await linuses.next("error")).toEqual(failed("huddle.answer"));
    expect(warned).toHaveBeenLastCalledWith("A huddle's huddle.answer failed:", "The Realtime SFU answered 406 (invalid_session_description)");
    await vi.waitFor(() => expect(closedOn(sfu, second)).toEqual(["0", "1"]));

    // And then hears everyone, on a third.
    expect((await listen(linuses, true))!.tracks).toHaveLength(2);
    expect(newest(sfu)).not.toBe(second);
    const said = JSON.stringify(warned.mock.calls);
    for (const secret of [APP.appSecret, ...sfu.sessions.keys()]) expect(said).not.toContain(secret);
  });

  it("has a tab publish again once the SFU no longer finds what it published", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("lost");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await publishing(sfu, adas);
    await graces.next("huddle.changed");
    await linuses.next("huddle.changed");

    // The SFU can take a moment to find what a tab has just published, so nothing comes of that.
    sfu.sessions.get(fromAda)!.published.clear();
    expect(await listen(linuses, true)).toBeNull();
    vi.setSystemTime(Date.now() + PUBLICATION_SETTLES_MS - 1);
    expect(await listen(linuses)).toBeNull();
    await reached(adas, graces);
    expect([...adas.pending("huddle.unpublished"), ...graces.pending("huddle.changed")]).toEqual([]);

    // Later, it's gone: her tab publishes again, and nobody can listen to her meanwhile.
    vi.setSystemTime(Date.now() + 1);
    expect(await listen(linuses)).toBeNull();
    expect(await adas.next("huddle.unpublished")).toEqual({ type: "huddle.unpublished", kind: "audio" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada) });
    expect(await linuses.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada) });
    // Which the room says once.
    const asked = sfu.asked.length;
    expect(await listen(linuses)).toBeNull();
    expect(await listen(graces, true)).toBeNull();
    await reached(adas);
    expect(adas.pending("huddle.unpublished")).toEqual([]);
    expect(sfu.asked).toHaveLength(asked);

    await publishing(sfu, adas, "Ada's second offer");
    expect((await listen(linuses))!.tracks).toEqual([{ mid: "0", kind: "audio", userId: ada.user.id }]);
  });

  it("asks the SFU one thing at a time for each of a tab's connections, and takes only a few frames waiting", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("in-turn");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    await publishing(sfu, graces);
    await adas.next("huddle.changed");

    const release = sfu.hold(/sessions\/new$/);
    for (let n = 1; n <= 6; n++) adas.send(microphone(`offer ${n}`));
    // The first is with the SFU, and four wait behind it.
    expect(await adas.next("error")).toEqual({ type: "error", message: TOO_FAST });
    expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(2);
    // Her muting waits on nothing, and her other connection only on itself.
    adas.send({ type: "huddle.mute", muted: true });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { muted: true }) });
    expect((await listen(adas, true))!.tracks).toEqual([{ mid: "0", kind: "audio", userId: grace.user.id }]);
    expect(adas.pending("huddle.published")).toEqual([]);

    release();
    for (let n = 1; n <= 5; n++) expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "audio", sdp: `answer to offer ${n}` });
    // Each took the place of the one before it, which the SFU closed.
    const hers = sfu.publishers.slice(1);
    expect(hers).toHaveLength(5);
    await vi.waitFor(() => expect(hers.map((id) => closedOn(sfu, id))).toEqual([["0"], ["0"], ["0"], ["0"], []]));
    expect((await remembered(room))[0]!.publishing).toEqual({ sessionId: hers[4], tracks: [{ mid: "0", kind: "audio" }] });
  });

  it("has the SFU close what it made for a tab that left while it answered", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("left-meanwhile");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    await publishing(sfu, adas);

    // Grace's microphone, published as she leaves.
    const publish = sfu.hold(/tracks\/new$/);
    graces.send(microphone("Grace's offer"));
    await vi.waitFor(() => expect(sfu.askedTo(/tracks\/new$/)).toHaveLength(2));
    graces.leave();
    await adas.next("huddle.left");
    publish();
    await vi.waitFor(() => expect(closedOn(sfu, sfu.publishers[1]!)).toEqual(["0"]));

    // And what Linus was to hear, offered as he leaves.
    const linuses = await welcomed(room, await signIn("Linus"));
    const pull = sfu.hold(/tracks\/new$/);
    linuses.send({ type: "huddle.listen", fresh: true });
    await vi.waitFor(() => expect(sfu.askedTo(/tracks\/new$/)).toHaveLength(3));
    const toLinus = newest(sfu);
    linuses.leave();
    await adas.next("huddle.left");
    pull();
    await vi.waitFor(() => expect(closedOn(sfu, toLinus)).toEqual(["0"]));
    expect(await remembered(room)).toHaveLength(1);
  });

  it("keeps who's in a huddle, and what each publishes and hears, while the room hibernates", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("hibernating");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace, true);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    await listen(graces, true);
    const toGrace = newest(sfu);
    const before = await remembered(room);

    await evictDurableObject(roomStub(room));

    expect(await remembered(room)).toEqual(before);
    expect(before).toMatchObject([
      { huddle: true, user: ada.user, roomId: room, muted: false, appId: APP.appId, publishing: { sessionId: fromAda, tracks: [{ mid: "0", kind: "audio" }], connectedAt: expect.any(Number) as number } },
      { user: grace.user, muted: true, publishing: { sessionId: fromGrace }, receiving: { sessionId: toGrace, heard: [{ mid: "0", from: fromAda, kind: "audio" }] } },
    ]);
    const asked = sfu.asked.length;
    expect(await listen(graces)).toBeNull();
    expect(sfu.asked).toHaveLength(asked);
    const linuses = await joinHuddle(room, linus);
    expect((await linuses.next("huddle.welcome")).people).toEqual([person(ada, { audio: true }), person(grace, { muted: true, audio: true }), person(linus)]);
    expect((await listen(linuses, true))!.tracks).toHaveLength(2);
    graces.leave();
    await vi.waitFor(() => expect([closedOn(sfu, fromGrace), closedOn(sfu, toGrace)]).toEqual([["0"], ["0"]]));
  });
});

describe("Cameras in a huddle", () => {
  it("publishes a tab's camera on a session of its own, beside its microphone's, and has the others hear they can watch it once its connection has connected", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("camera");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const voice = await publishing(sfu, adas);
    await graces.next("huddle.changed");
    const asked = sfu.asked.length;

    adas.send(camera("Ada's camera"));
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "video", sdp: "answer to Ada's camera" });
    const picture = sfu.publishers.at(-1)!;
    expect(picture).not.toBe(voice);
    expect(sfu.asked.slice(asked)).toEqual([
      { appId: APP.appId, method: "POST", path: "/sessions/new", body: null },
      {
        appId: APP.appId,
        method: "POST",
        path: `/sessions/${picture}/tracks/new`,
        sessionId: picture,
        body: { sessionDescription: { type: "offer", sdp: "Ada's camera" }, tracks: [{ location: "local", mid: "0", trackName: "video" }] },
      },
    ]);
    // Nobody can watch her until her tab says that connection has connected, which saying so of her microphone's isn't.
    adas.send({ type: "huddle.connected" });
    adas.send({ type: "huddle.connected", kind: "audio" });
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);
    adas.send({ type: "huddle.connected", kind: "video" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true, video: true }) });
    expect((await (await joinHuddle(room, await signIn("Linus"))).next("huddle.welcome")).people[0]).toEqual(person(ada, { audio: true, video: true }));

    // None of it touched what carries her voice.
    expect(closedOn(sfu, voice)).toEqual([]);
    expect((await remembered(room))[0]).toMatchObject({
      publishing: { sessionId: voice, tracks: [{ mid: "0", kind: "audio" }] },
      cameras: { publishing: { sessionId: picture, tracks: [{ mid: "0", kind: "video" }], connectedAt: expect.any(Number) as number } },
    });
  });

  it("offers a tab the cameras it asks to watch, on a session of its own, and has the SFU close those it no longer asks for", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("watching");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    for (const socket of [adas, graces]) await publishMicrophone(socket);
    const fromAda = await showing(sfu, adas);
    await showing(sfu, graces);
    await listen(linuses, true);
    const voices = newest(sfu);

    // Asked for nobody's, he's offered nobody's, and the SFU is asked nothing.
    const asked = sfu.asked.length;
    expect(await watch(linuses, [])).toBeNull();
    expect(sfu.asked).toHaveLength(asked);

    expect(await watch(linuses, [ada.user.id])).toEqual({ type: "huddle.offer", kind: "video", sdp: expect.any(String) as string, tracks: [{ mid: "0", kind: "video", userId: ada.user.id }] });
    const pictures = newest(sfu);
    expect(pictures).not.toBe(voices);
    expect(sfu.asked.at(-2)).toMatchObject({ path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video" }] } });
    // Asking for Grace's as well adds hers, and asking for hers alone has the SFU close Ada's.
    expect((await watch(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: grace.user.id }]);
    expect(await watch(linuses, [grace.user.id])).toBeNull();
    expect(closedOn(sfu, pictures)).toEqual(["0"]);
    // Himself, or someone who isn't in the huddle, is nobody to watch.
    expect(await watch(linuses, [grace.user.id, linus.user.id, "nobody"])).toBeNull();
    expect(await watch(linuses, [])).toBeNull();
    expect(closedOn(sfu, pictures)).toEqual(["0", "1"]);
    expect((await remembered(room))[2]).toMatchObject({ receiving: { sessionId: voices, heard: [{ kind: "audio" }, { kind: "audio" }] }, cameras: { receiving: { sessionId: pictures, heard: [] } } });

    // A tab that asks to listen, as one from before there were cameras does, is offered voices alone, and asking to watch changes nothing it hears.
    expect((await listen(graces, true))!.tracks).toEqual([{ mid: "0", kind: "audio", userId: ada.user.id }]);
    expect(closedOn(sfu, voices)).toEqual([]);
  });

  it("takes a tab's camera down when it says so: the others hear they can't watch it, and the SFU closes it", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("camera-off");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const voice = await publishing(sfu, adas);
    const picture = await showing(sfu, adas);
    await watch(graces, [ada.user.id], true);
    const watching = newest(sfu);
    await graces.next("huddle.changed");
    await graces.next("huddle.changed");

    adas.send({ type: "huddle.unpublish", kind: "video" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true }) });
    await vi.waitFor(() => expect(closedOn(sfu, picture)).toEqual(["0"]));
    expect(closedOn(sfu, voice)).toEqual([]);
    expect((await remembered(room))[0]!.cameras).toEqual({});
    // Said again, it's nothing new.
    const asked = sfu.asked.length;
    adas.send({ type: "huddle.unpublish", kind: "video" });
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);
    expect(sfu.asked).toHaveLength(asked);
    // What Grace watched of it is closed as her tab next asks, whoever it asks for.
    expect(await watch(graces, [ada.user.id])).toBeNull();
    expect(closedOn(sfu, watching)).toEqual(["0"]);

    // One that goes off before anyone could watch it is closed without a word, and one that comes on again is another session's.
    adas.send(camera("Ada's second camera"));
    await adas.next("huddle.published");
    const second = sfu.publishers.at(-1)!;
    adas.send({ type: "huddle.unpublish", kind: "video" });
    await vi.waitFor(() => expect(closedOn(sfu, second)).toEqual(["0"]));
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);
    const third = await showing(sfu, adas, "Ada's third camera");
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true, video: true }) });
    expect((await watch(graces, [ada.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: ada.user.id }]);
    expect(sfu.asked.at(-2)).toMatchObject({ body: { tracks: [{ sessionId: third, trackName: "video" }] } });

    // A microphone comes down the same way.
    adas.send({ type: "huddle.unpublish", kind: "audio" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { video: true }) });
    await vi.waitFor(() => expect(closedOn(sfu, voice)).toEqual(["0"]));
  });

  it("shows twenty-five cameras, and refuses the next until one goes off", async () => {
    const { sfu } = await huddlesOn();
    const room = await freshRoom("cameras-full");
    const sockets = await crowd(room, MAX_HUDDLE_PEOPLE);
    for (const socket of sockets) await publishMicrophone(socket);
    const shown = sockets.slice(0, MAX_HUDDLE_CAMERAS);
    for (const socket of shown) await publishCamera(socket);
    const [next, last] = [sockets[MAX_HUDDLE_CAMERAS]!, sockets.at(-1)!];

    // One more is refused before the SFU is asked anything, which its tab hears as its camera staying off.
    const asked = sfu.asked.length;
    next.send(camera("one camera too many"));
    expect(await next.next("error")).toEqual({ type: "error", message: CAMERAS_FULL, failed: "huddle.publish", kind: "video", refused: true });
    expect(sfu.asked).toHaveLength(asked);

    // Someone can watch them all while hearing everyone: what a socket remembers of both fits it.
    await listen(last, true);
    const offer = await watch(
      last,
      shown.map((_, n) => `person-${n}`),
      true,
    );
    expect(new Set(offer!.tracks.map(({ userId }) => userId)).size).toBe(MAX_HUDDLE_CAMERAS);
    const remembers = (await remembered(room)).at(-1)!;
    expect([remembers.receiving!.heard.length, remembers.cameras!.receiving!.heard.length]).toEqual([MAX_HUDDLE_PEOPLE - 1, MAX_HUDDLE_CAMERAS]);

    // Once someone turns theirs off there's room for one, and only one, even when two ask while the SFU answers the first.
    shown[0]!.send({ type: "huddle.unpublish", kind: "video" });
    await reached(shown[0]!);
    const started = sfu.askedTo(/sessions\/new$/).length;
    const release = sfu.hold(/sessions\/new$/);
    next.send(camera("the camera after"));
    await vi.waitFor(() => expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(started + 1));
    await publishCamera(last);
    release();
    expect(await next.next("error")).toMatchObject({ message: CAMERAS_FULL, kind: "video", refused: true });
    // What the SFU made for it meanwhile is closed.
    await vi.waitFor(() => expect(closedOn(sfu, newest(sfu))).toEqual(["0"]));
    expect((await remembered(room)).filter(({ cameras }) => cameras?.publishing)).toHaveLength(MAX_HUDDLE_CAMERAS);
  });

  it("refuses cameras once its check hears that an administrator has them off, and takes down the ones that are on, a few a check", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("cameras-off");
    const sockets = await crowd(room, 10);
    const microphones: string[] = [];
    for (const socket of sockets) microphones.push(await publishing(sfu, socket));
    const cameras: string[] = [];
    for (const socket of sockets) cameras.push(await showing(sfu, socket));
    const watcher = sockets.at(-1)!;
    await reached(watcher);
    const heard = watcher.log.length;
    const stillShown = async () => (await remembered(room)).filter(({ cameras }) => cameras?.publishing).length;

    // Each tab hears why its camera went off, the others that they can't watch it, and the SFU closes it: the first eight to have joined.
    await switchCameras(ada, false);
    await ring(room);
    for (const socket of sockets.slice(0, 8)) expect(await socket.next("error")).toEqual(CAMERA_OFF);
    await vi.waitFor(() => expect(cameras.slice(0, 8).map((id) => closedOn(sfu, id))).toEqual(cameras.slice(0, 8).map(() => ["0"])));
    await reached(watcher);
    const changed = watcher.log.slice(heard).filter(({ type }) => type === "huddle.changed");
    expect(changed).toEqual(sockets.slice(0, 8).map((_, n) => ({ type: "huddle.changed", person: { user: { id: `person-${n}`, name: `Person ${n}` }, muted: false, audio: true, video: false, screen: false } })));
    expect(await stillShown()).toBe(2);
    // And the rest at the next.
    await ring(room);
    for (const socket of sockets.slice(8)) expect(await socket.next("error")).toEqual(CAMERA_OFF);
    await vi.waitFor(() => expect(cameras.map((id) => closedOn(sfu, id))).toEqual(cameras.map(() => ["0"])));
    expect(await stillShown()).toBe(0);
    // Their microphones go on as they were, and a check with no camera on asks the SFU nothing.
    expect(microphones.map((id) => closedOn(sfu, id))).toEqual(microphones.map(() => []));
    const asked = sfu.asked.length;
    await ring(room);
    expect(sfu.asked).toHaveLength(asked);

    // One that asks is refused before the SFU is asked anything.
    sockets[0]!.send(camera("a camera while they're off"));
    expect(await sockets[0]!.next("error")).toEqual(CAMERA_OFF);
    expect(sfu.asked).toHaveLength(asked);

    // On again, cameras go on as before.
    await switchCameras(ada, true);
    await ring(room);
    await showing(sfu, sockets[0]!, "a camera once they're on");
    expect(await stillShown()).toBe(1);
  });

  it("refuses a camera the SFU was still answering for when its check heard that cameras are off", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("cameras-off-late");
    const adas = await welcomed(room, ada);
    const started = sfu.askedTo(/sessions\/new$/).length;
    const release = sfu.hold(/sessions\/new$/);
    adas.send(camera("Ada's camera"));
    await vi.waitFor(() => expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(started + 1));
    await switchCameras(ada, false);
    // Nothing of hers is on for the check to take down.
    await ring(room);
    release();
    expect(await adas.next("error")).toEqual(CAMERA_OFF);
    // What the SFU made for it meanwhile is closed.
    await vi.waitFor(() => expect(closedOn(sfu, newest(sfu))).toEqual(["0"]));
    expect((await remembered(room))[0]!.cameras?.publishing).toBeUndefined();
  });

  it("lets cameras go on, and screens be shared, when the Workspace says nothing of them, as one from before they could be turned off does", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("cameras-unsaid");
    const adas = await welcomed(room, ada);
    await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
      const huddle = (instance as unknown as { huddle: { env: Env } }).huddle;
      const reached = workspace(huddle.env);
      const older = { huddleApp: async () => APP, reportHuddle: (...report: Parameters<typeof reached.reportHuddle>) => reached.reportHuddle(...report) };
      huddle.env = { ...huddle.env, WORKSPACE: { getByName: () => older } as unknown as Env["WORKSPACE"] };
    });
    await ring(room);
    await showing(sfu, adas);
    await sharing(sfu, adas);
    await ring(room);
    const [hers] = await remembered(room);
    expect([hers!.cameras?.publishing, hers!.screens?.publishing]).toEqual([expect.anything(), expect.anything()]);
    expect(adas.pending("error")).toEqual([]);
  });

  it("has the SFU close everything a tab sent and received, on all four of its connections, once it leaves", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("leaving-cameras");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const adasOwn = [await publishing(sfu, adas), await showing(sfu, adas)];
    const gracesOwn = [await publishing(sfu, graces), await showing(sfu, graces)];
    await listen(graces, true);
    gracesOwn.push(newest(sfu));
    await watch(graces, [ada.user.id], true);
    gracesOwn.push(newest(sfu));

    graces.leave();
    await vi.waitFor(() => expect(gracesOwn.map((id) => closedOn(sfu, id))).toEqual([["0"], ["0"], ["0"], ["0"]]));
    expect(adasOwn.map((id) => closedOn(sfu, id))).toEqual([[], []]);
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
  });

  it("has the SFU close microphones before cameras when a huddle ends with its room", async () => {
    const { ada, sfu } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Short-lived", { as: ada })).id;
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const [adasVoice, adasPicture] = [await publishing(sfu, adas), await showing(sfu, adas)];
    const [gracesVoice, gracesPicture] = [await publishing(sfu, graces), await showing(sfu, graces)];
    await watch(graces, [ada.user.id], true);
    const asked = sfu.asked.length;

    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    await vi.waitFor(() => expect(sfu.asked).toHaveLength(asked + 4));
    await sleep(20);
    expect(sfu.asked.slice(asked).map(({ path }) => path)).toEqual([adasVoice, gracesVoice, adasPicture, gracesPicture].map((id) => `/sessions/${id}/tracks/close`));
  });

  it("asks the SFU no more than an event may when a full huddle ends with its room: to close every microphone, and the cameras from its alarm, before the room is erased", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = (await createRoom("Crowded", { as: ada })).id;
    const sockets = await crowd(room, MAX_HUDDLE_PEOPLE);
    const microphones: string[] = [];
    for (const socket of sockets) microphones.push(await publishing(sfu, socket));
    const cameras: string[] = [];
    for (const socket of sockets.slice(0, MAX_HUDDLE_CAMERAS)) cameras.push(await showing(sfu, socket));
    const asked = sfu.asked.length;
    const sessionsAsked = () =>
      sfu.asked
        .slice(asked)
        .map(({ sessionId }) => sessionId)
        .sort();

    const deletedAt = Date.now();
    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    await vi.waitFor(() => expect(sfu.asked.length - asked).toBe(MAX_HUDDLE_PEOPLE));
    await sleep(20);
    expect(sessionsAsked()).toEqual([...microphones].sort());
    // The cameras wait for the room's alarm, which comes within a check for them, and no longer when the room is to be erased.
    await vi.waitFor(async () => expect(await kept(room, "huddleUnclosed")).toMatchObject(cameras.map((sessionId) => ({ appId: APP.appId, sessionId, mids: ["0"] }))));
    await vi.waitFor(async () => expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS));
    const eraseDue = (await kept(room, "eraseDue")) as number;
    expect(eraseDue).toBeGreaterThanOrEqual(deletedAt + REVOCATIONS_KEPT_MS);

    // A few sessions an alarm, until none is left.
    await ring(room);
    expect(await kept(room, "huddleUnclosed")).toHaveLength(MAX_HUDDLE_CAMERAS - 10);
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);
    await ring(room);
    await ring(room);
    expect(cameras.map((id) => closedOn(sfu, id))).toEqual(cameras.map(() => ["0"]));
    expect(sessionsAsked()).toEqual([...microphones, ...cameras].sort());
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
    // The room is erased no sooner than it was to be.
    expect(await alarmOf(room)).toBe(eraseDue);
    expect(await kept(room, "deletedRoom")).toBe(room);
    await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.put("eraseDue", Date.now() - 1));
    await ring(room);
    expect(await runInDurableObject(roomStub(room), async (_room, state: DurableObjectState) => [...(await state.storage.list()).keys()])).toEqual([]);
    expect(await alarmOf(room)).toBeNull();
  });

  it("keeps what each tab shows and watches while the room hibernates", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("hibernating-cameras");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const voice = await publishing(sfu, adas);
    const picture = await showing(sfu, adas);
    await watch(graces, [ada.user.id], true);
    const watching = newest(sfu);
    const before = await remembered(room);

    await evictDurableObject(roomStub(room));

    expect(await remembered(room)).toEqual(before);
    expect(before).toMatchObject([
      { user: ada.user, publishing: { sessionId: voice }, cameras: { publishing: { sessionId: picture, tracks: [{ mid: "0", kind: "video" }], connectedAt: expect.any(Number) as number } } },
      { user: grace.user, cameras: { receiving: { sessionId: watching, heard: [{ mid: "0", from: picture, kind: "video" }] } } },
    ]);
    const asked = sfu.asked.length;
    expect(await watch(graces, [ada.user.id])).toBeNull();
    expect(sfu.asked).toHaveLength(asked);
    expect((await (await joinHuddle(room, await signIn("Linus"))).next("huddle.welcome")).people[0]).toEqual(person(ada, { audio: true, video: true }));
    adas.leave();
    await vi.waitFor(() => expect([closedOn(sfu, voice), closedOn(sfu, picture)]).toEqual([["0"], ["0"]]));
  });

  it("has a tab show its camera again once the SFU no longer finds it, without a word about its microphone", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("camera-lost");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    await publishing(sfu, adas);
    const picture = await showing(sfu, adas);
    await graces.next("huddle.changed");
    await graces.next("huddle.changed");

    sfu.sessions.get(picture)!.published.clear();
    vi.setSystemTime(Date.now() + PUBLICATION_SETTLES_MS);
    expect(await watch(graces, [ada.user.id], true)).toBeNull();
    expect(await adas.next("huddle.unpublished")).toEqual({ type: "huddle.unpublished", kind: "video" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true }) });
    await reached(adas);
    expect(adas.pending("huddle.unpublished")).toEqual([]);

    await showing(sfu, adas, "Ada's second camera");
    expect((await watch(graces, [ada.user.id]))!.tracks).toEqual([{ mid: "0", kind: "video", userId: ada.user.id }]);
  });

  it("asks the SFU about a tab's camera without waiting on its microphone", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("camera-in-turn");
    const adas = await welcomed(room, ada);

    const release = sfu.hold(/sessions\/new$/);
    adas.send(microphone("Ada's offer"));
    await vi.waitFor(() => expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(1));
    adas.send(camera("Ada's camera"));
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "video", sdp: "answer to Ada's camera" });
    release();
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "audio", sdp: "answer to Ada's offer" });
  });

  it("tells a tab which of its connections the SFU refused it on, and lets go of that one alone", async () => {
    const { ada, sfu } = await huddlesOn();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = await freshRoom("camera-refused");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    await publishing(sfu, adas);

    // A camera the SFU doesn't take isn't shown, and her microphone stays as it was.
    sfu.refuse(/tracks\/new$/);
    adas.send(camera("Ada's camera"));
    expect(await adas.next("error")).toEqual(failed("huddle.publish", "video"));
    expect(warned).toHaveBeenLastCalledWith("A huddle's huddle.publish failed:", "The Realtime SFU answered 500 (internal_error)");
    expect((await remembered(room))[0]).toMatchObject({ publishing: { connectedAt: expect.any(Number) as number } });
    expect((await remembered(room))[0]!.cameras).toBeUndefined();
    await showing(sfu, adas);

    // A tab the SFU refuses to offer a camera starts watching over, and goes on hearing what it heard.
    await listen(graces, true);
    const voices = newest(sfu);
    await watch(graces, [ada.user.id], true);
    const pictures = newest(sfu);
    await showing(sfu, linuses);
    sfu.refuse(/tracks\/new$/, 503, "temporarily_unavailable_error");
    graces.send({ type: "huddle.listen", kind: "video", watch: [ada.user.id, linus.user.id] });
    expect(await graces.next("error")).toEqual(failed("huddle.listen", "video"));
    await vi.waitFor(() => expect(closedOn(sfu, pictures)).toEqual(["0"]));
    const hers = (await remembered(room))[1]!;
    expect(hers.receiving).toMatchObject({ sessionId: voices, heard: [{ kind: "audio" }] });
    expect(hers.cameras).toEqual({});
    expect(closedOn(sfu, voices)).toEqual([]);
    expect((await watch(graces, [ada.user.id, linus.user.id], true))!.tracks).toHaveLength(2);
    expect(newest(sfu)).not.toBe(pictures);
  });
});

/** The offer a tab makes for a camera its browser sends in sizes of these names, which are both of a camera's unless said, in the one media section it has. */
const inSizes = (sizes = "b;a") => ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", "a=sendonly", `a=simulcast:send ${sizes}`, ""].join("\r\n");

/** How the room asks the SFU for the size of a camera that `rid` names. */
const sizeOf = (rid: string) => ({ preferredRid: rid, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" });

describe("A camera's sizes in a huddle", () => {
  it("has a tab sent the size it shows cameras in, of a camera sent in both: asked for with the camera, and changed for one it watches already", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes");
    const [grace, linus, margaret] = [await signIn("Grace"), await signIn("Linus"), await signIn("Margaret")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, "Grace's camera");
    expect(await remembered(room)).toMatchObject([{ cameras: { publishing: { sessionId: fromAda, sized: true } } }, { cameras: { publishing: { sessionId: fromGrace } } }, {}]);
    expect((await remembered(room))[1]!.cameras!.publishing).not.toHaveProperty("sized");

    // Large, unless the tab says small: of Ada's, which is sent in both, and Grace's is asked for as it is.
    expect((await watch(linuses, [ada.user.id, grace.user.id], true))!.tracks).toHaveLength(2);
    const pictures = newest(sfu);
    expect(sfu.asked.at(-2)).toEqual({
      appId: APP.appId,
      method: "POST",
      path: `/sessions/${pictures}/tracks/new`,
      sessionId: pictures,
      body: {
        tracks: [
          { location: "remote", sessionId: fromAda, trackName: "video", simulcast: sizeOf("a") },
          { location: "remote", sessionId: fromGrace, trackName: "video" },
        ],
      },
    });
    const watched = async () => (await remembered(room))[2]!.cameras!.receiving;
    expect(await watched()).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video", size: "a" }, { mid: "1", from: fromGrace, kind: "video" }] });

    // Shown small, Ada's is sent small from then on, on the media section that carries it, and Grace's is left as it is.
    let asked = sfu.asked.length;
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked.slice(asked)).toEqual([
      {
        appId: APP.appId,
        method: "PUT",
        path: `/sessions/${pictures}/tracks/update`,
        sessionId: pictures,
        body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video", mid: "0", simulcast: sizeOf("b") }] },
      },
    ]);
    expect(sfu.sessions.get(pictures)!.pulled.get("0")).toEqual({ sessionId: fromAda, trackName: "video", rid: "b" });
    expect(await watched()).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video", size: "b" }, { mid: "1", from: fromGrace, kind: "video" }] });

    // Which the room remembers while it hibernates: asked again, the SFU is asked nothing, and asked for large, to change it back.
    await evictDurableObject(roomStub(room));
    asked = sfu.asked.length;
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked).toHaveLength(asked);
    expect(await watch(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked.slice(asked)).toMatchObject([{ path: `/sessions/${pictures}/tracks/update`, body: { tracks: [{ sessionId: fromAda, mid: "0", simulcast: sizeOf("a") }] } }]);
    expect(sfu.sessions.get(pictures)!.pulled.get("0")!.rid).toBe("a");

    // A tab that shows cameras small from the first is sent Ada's small from the first.
    const margarets = await welcomed(room, margaret);
    expect((await watchSmall(margarets, [ada.user.id], true))!.tracks).toEqual([{ mid: "0", kind: "video", userId: ada.user.id }]);
    expect(sfu.asked.at(-2)!.body).toEqual({ tracks: [{ location: "remote", sessionId: fromAda, trackName: "video", simulcast: sizeOf("b") }] });
    expect((await remembered(room))[3]!.cameras!.receiving!.heard).toEqual([{ mid: "0", from: fromAda, kind: "video", size: "b" }]);
  });

  it("changes the sizes of the cameras a tab watches before it offers it anyone new, in one request, and asks for the new ones in the size it shows now", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-and-more");
    const [grace, linus, margaret] = [await signIn("Grace"), await signIn("Linus"), await signIn("Margaret")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const margarets = await welcomed(room, margaret);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes("a;b"));
    await watch(margarets, [ada.user.id, grace.user.id], true);
    const pictures = newest(sfu);
    const fromLinus = await showing(sfu, linuses, inSizes());

    const asked = sfu.asked.length;
    expect((await watchSmall(margarets, [ada.user.id, grace.user.id, linus.user.id]))!.tracks).toEqual([{ mid: "2", kind: "video", userId: linus.user.id }]);
    expect(sfu.asked.slice(asked).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      {
        method: "PUT",
        path: `/sessions/${pictures}/tracks/update`,
        body: {
          tracks: [
            { location: "remote", sessionId: fromAda, trackName: "video", mid: "0", simulcast: sizeOf("b") },
            { location: "remote", sessionId: fromGrace, trackName: "video", mid: "1", simulcast: sizeOf("b") },
          ],
        },
      },
      { method: "POST", path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromLinus, trackName: "video", simulcast: sizeOf("b") }] } },
      { method: "PUT", path: `/sessions/${pictures}/renegotiate`, body: { sessionDescription: { type: "answer", sdp: expect.any(String) as string } } },
    ]);
    expect((await remembered(room))[3]!.cameras!.receiving!.heard.map(({ mid, size }) => ({ mid, size }))).toEqual([
      { mid: "0", size: "b" },
      { mid: "1", size: "b" },
      { mid: "2", size: "b" },
    ]);
  });

  it("takes a camera to be sent in one size unless its offer sends both and the SFU's answer takes both", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("one-size");
    const [grace, linus, margaret] = [await signIn("Grace"), await signIn("Linus"), await signIn("Margaret")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const margarets = await welcomed(room, margaret);
    // Sizes of other names, which the room has no word for, and a screen, which comes in one.
    const fromAda = await showing(sfu, adas, inSizes("f;h;q"));
    const screenOfAda = await sharing(sfu, adas, inSizes());
    // An SFU that takes one size has the browser send one, whatever its offer said.
    sfu.takeOneSize();
    graces.send(camera(inSizes()));
    expect((await graces.next("huddle.published")).sdp).not.toContain("a=simulcast");
    graces.send({ type: "huddle.connected", kind: "video" });
    await reached(graces);
    const fromGrace = sfu.publishers.at(-1)!;
    for (const { cameras, screens } of await remembered(room)) for (const publishing of [cameras?.publishing, screens?.publishing]) if (publishing) expect(publishing).not.toHaveProperty("sized");

    await watchSmall(margarets, [ada.user.id, grace.user.id], true);
    expect(sfu.asked.at(-2)!.body).toEqual({
      tracks: [
        { location: "remote", sessionId: fromAda, trackName: "video" },
        { location: "remote", sessionId: fromGrace, trackName: "video" },
      ],
    });
    await watch(linuses, [ada.user.id], true, "screen");
    expect(sfu.asked.at(-2)!.body).toEqual({ tracks: [{ location: "remote", sessionId: screenOfAda, trackName: "screen" }] });
    // Nothing of theirs has a size to change.
    const asked = sfu.asked.length;
    expect(await watch(margarets, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked).toHaveLength(asked);
  });

  it("offers a tab a change of sizes that takes an offer, and anyone new once it has answered that", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-offered");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    await watch(linuses, [ada.user.id], true);
    const pictures = newest(sfu);
    const fromGrace = await showing(sfu, graces, inSizes());

    sfu.answerInstead(/\/tracks\/update$/, () => {
      sfu.sessions.get(pictures)!.offering = true;
      return Response.json({ requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "an offer of other sizes" }, tracks: [{ mid: "0", sessionId: fromAda, trackName: "video" }] });
    });
    const asked = sfu.asked.length;
    linuses.send({ type: "huddle.listen", kind: "video", watch: [ada.user.id, grace.user.id], small: true });
    expect(await linuses.next("huddle.offer")).toEqual({ type: "huddle.offer", kind: "video", sdp: "an offer of other sizes", tracks: [] });
    // Grace's waits: the session takes nothing more until that offer is answered.
    expect(sfu.asked.slice(asked).map(({ path }) => path)).toEqual([`/sessions/${pictures}/tracks/update`]);
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video", size: "b" }], offered: [] });
    linuses.send({ type: "huddle.listen", kind: "video", watch: [ada.user.id, grace.user.id], small: true });
    await reached(linuses);
    expect(sfu.asked.slice(asked)).toHaveLength(1);

    linuses.send({ type: "huddle.answer", kind: "video", sdp: "Linus's answer" });
    expect(await linuses.next("huddle.listening")).toEqual({ type: "huddle.listening", kind: "video" });
    expect(sfu.sessions.get(pictures)!.answers).toContain("Linus's answer");
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video", size: "b" }] });
    expect((await watchSmall(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: grace.user.id }]);
    expect(sfu.asked.at(-2)!.body).toEqual({ tracks: [{ location: "remote", sessionId: fromGrace, trackName: "video", simulcast: sizeOf("b") }] });
  });

  it("leaves a camera in the size it was when the SFU won't change it, without a word to the tab, and asks again with the tab's next round", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-refused");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    await watch(linuses, [ada.user.id, grace.user.id], true);
    const pictures = newest(sfu);
    const sizes = async () => (await remembered(room))[2]!.cameras!.receiving!.heard.map(({ size }) => size);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The request refused, and then left unanswered: the tab is listening as it was, on the connection it had.
    sfu.refuse(/\/tracks\/update$/, 500, "internal_error");
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(await sizes()).toEqual(["a", "a"]);
    sfu.answerInstead(/\/tracks\/update$/, () => Response.json({ requiresImmediateRenegotiation: false }));
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(await sizes()).toEqual(["a", "a"]);
    // One camera of the two refused: the other is small from then on.
    sfu.answerInstead(/\/tracks\/update$/, () =>
      Response.json({
        requiresImmediateRenegotiation: false,
        tracks: [
          { mid: "0", sessionId: fromAda, trackName: "video", errorCode: "update_track_error", errorDescription: "The track is not configured for the requested simulcast update" },
          { mid: "1", sessionId: fromGrace, trackName: "video" },
        ],
      }),
    );
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(await sizes()).toEqual(["a", "b"]);
    expect(linuses.pending("error")).toEqual([]);
    expect(sfu.sessions.get(pictures)!.closed).toEqual([]);
    expect(warned.mock.calls.map(([said, what]) => `${said as string} ${what as string}`)).toEqual([
      "Changing the size of a huddle's cameras failed: The Realtime SFU answered 500 (internal_error)",
      "The Realtime SFU didn't change the size of a huddle's camera: missing",
      "The Realtime SFU didn't change the size of a huddle's camera: update_track_error",
    ]);

    // Asked again, only the one that isn't small yet is asked for.
    const asked = sfu.asked.length;
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked.slice(asked).map(({ body }) => body)).toEqual([{ tracks: [{ location: "remote", sessionId: fromAda, trackName: "video", mid: "0", simulcast: sizeOf("b") }] }]);
    expect(await sizes()).toEqual(["b", "b"]);
  });

  it("closes a camera the SFU won't make larger and asks for it anew, without a size, as it asks for cameras on that connection from then on: a tab that shows cameras large isn't left a small picture of one", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-left-small");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    // Linus's tab shows cameras small from the first, and is sent both small.
    await watchSmall(linuses, [ada.user.id, grace.user.id], true);
    const pictures = newest(sfu);
    const watched = async () => (await remembered(room))[2]!.cameras!.receiving;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Shown large, Grace's is made larger and Ada's isn't, which the tab is offered again on the connection it has.
    sfu.answerInstead(/\/tracks\/update$/, () =>
      Response.json({
        requiresImmediateRenegotiation: false,
        tracks: [
          { mid: "0", sessionId: fromAda, trackName: "video", errorCode: "update_track_error", errorDescription: "Track can't be updated" },
          { mid: "1", sessionId: fromGrace, trackName: "video" },
        ],
      }),
    );
    let asked = sfu.asked.length;
    expect((await watch(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "2", kind: "video", userId: ada.user.id }]);
    expect(sfu.asked.slice(asked).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      {
        method: "PUT",
        path: `/sessions/${pictures}/tracks/update`,
        body: {
          tracks: [
            { location: "remote", sessionId: fromAda, trackName: "video", mid: "0", simulcast: sizeOf("a") },
            { location: "remote", sessionId: fromGrace, trackName: "video", mid: "1", simulcast: sizeOf("a") },
          ],
        },
      },
      { method: "PUT", path: `/sessions/${pictures}/tracks/close`, body: { tracks: [{ mid: "0" }], force: true } },
      { method: "POST", path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video" }] } },
      { method: "PUT", path: `/sessions/${pictures}/renegotiate`, body: expect.anything() as unknown },
    ]);
    expect(sfu.sessions.get(pictures)!.closed).toEqual(["0"]);
    const left = { sessionId: pictures, heard: [{ mid: "1", from: fromGrace, kind: "video", size: "a" }, { mid: "2", from: fromAda, kind: "video" }], unsized: true };
    expect(await watched()).toEqual(left);
    expect(warned).toHaveBeenCalledExactlyOnceWith("The Realtime SFU didn't change the size of a huddle's camera:", "update_track_error");

    // Shown small again, Grace's stays as large as it is, with nothing asked of the SFU.
    asked = sfu.asked.length;
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked).toHaveLength(asked);
    expect(await watched()).toEqual(left);
  });

  it("closes every small camera of a tab that shows them large, and asks for them anew, when the SFU refuses the change outright", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-all-left-small");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    await watchSmall(linuses, [ada.user.id, grace.user.id], true);
    const pictures = newest(sfu);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    sfu.refuse(/\/tracks\/update$/, 500, "internal_error");
    const asked = sfu.asked.length;
    expect((await watch(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([
      { mid: "2", kind: "video", userId: ada.user.id },
      { mid: "3", kind: "video", userId: grace.user.id },
    ]);
    expect(sfu.asked.slice(asked + 1).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/sessions/${pictures}/tracks/close`, body: { tracks: [{ mid: "0" }, { mid: "1" }], force: true } },
      {
        path: `/sessions/${pictures}/tracks/new`,
        body: {
          tracks: [
            { location: "remote", sessionId: fromAda, trackName: "video" },
            { location: "remote", sessionId: fromGrace, trackName: "video" },
          ],
        },
      },
      { path: `/sessions/${pictures}/renegotiate`, body: expect.anything() as unknown },
    ]);
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({
      sessionId: pictures,
      heard: [
        { mid: "2", from: fromAda, kind: "video" },
        { mid: "3", from: fromGrace, kind: "video" },
      ],
      unsized: true,
    });
  });

  it("offers a tab the change of sizes the SFU made, though it wouldn't make another camera larger, and that camera anew once the tab has answered", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-offered-and-left-small");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    await watchSmall(linuses, [ada.user.id, grace.user.id], true);
    const pictures = newest(sfu);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    sfu.answerInstead(/\/tracks\/update$/, () => {
      sfu.sessions.get(pictures)!.offering = true;
      return Response.json({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "an offer of other sizes" },
        tracks: [
          { mid: "0", sessionId: fromAda, trackName: "video", errorCode: "update_track_error", errorDescription: "Track can't be updated" },
          { mid: "1", sessionId: fromGrace, trackName: "video" },
        ],
      });
    });
    linuses.send({ type: "huddle.listen", kind: "video", watch: [ada.user.id, grace.user.id] });
    expect(await linuses.next("huddle.offer")).toEqual({ type: "huddle.offer", kind: "video", sdp: "an offer of other sizes", tracks: [] });
    expect(sfu.sessions.get(pictures)!.closed).toEqual(["0"]);
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: pictures, heard: [{ mid: "1", from: fromGrace, kind: "video", size: "a" }], unsized: true, offered: [] });

    linuses.send({ type: "huddle.answer", kind: "video", sdp: "Linus's answer" });
    await linuses.next("huddle.listening");
    const asked = sfu.asked.length;
    expect((await watch(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "2", kind: "video", userId: ada.user.id }]);
    expect(sfu.asked[asked]!.body).toEqual({ tracks: [{ location: "remote", sessionId: fromAda, trackName: "video" }] });
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({
      sessionId: pictures,
      heard: [
        { mid: "1", from: fromGrace, kind: "video", size: "a" },
        { mid: "2", from: fromAda, kind: "video" },
      ],
      unsized: true,
    });
  });

  it("closes the small cameras of a tab that comes to show them large on a connection that asks for no sizes, and asks for them anew, without asking the SFU to change them", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-unsized-small");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    // Linus's tab is sent Ada's small, and then the SFU won't send it Grace's in a size.
    await watchSmall(linuses, [ada.user.id], true);
    const pictures = newest(sfu);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sfu.refuseSizesOf(fromGrace);
    // While it shows them small, Ada's stays, and Grace's comes as the SFU would send it.
    let asked = sfu.asked.length;
    expect((await watchSmall(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: grace.user.id }]);
    expect(sfu.asked.slice(asked).map(({ path }) => path)).toEqual([`/sessions/${pictures}/tracks/new`, `/sessions/${pictures}/tracks/new`, `/sessions/${pictures}/renegotiate`]);
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({
      sessionId: pictures,
      heard: [
        { mid: "0", from: fromAda, kind: "video", size: "b" },
        { mid: "1", from: fromGrace, kind: "video" },
      ],
      unsized: true,
    });
    // Shown large, Ada's is closed and asked for again, as the SFU would send it.
    asked = sfu.asked.length;
    expect((await watch(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "2", kind: "video", userId: ada.user.id }]);
    expect(sfu.asked.slice(asked).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/sessions/${pictures}/tracks/close`, body: { tracks: [{ mid: "0" }], force: true } },
      { path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video" }] } },
      { path: `/sessions/${pictures}/renegotiate`, body: expect.anything() as unknown },
    ]);
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({
      sessionId: pictures,
      heard: [
        { mid: "1", from: fromGrace, kind: "video" },
        { mid: "2", from: fromAda, kind: "video" },
      ],
      unsized: true,
    });
  });

  it("asks for cameras without a size once the SFU won't send one in the size asked for, until the tab's next connection", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("unsized");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    await watch(linuses, [ada.user.id], true);
    const pictures = newest(sfu);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Her camera is asked for again in the same round, as the SFU would send it.
    sfu.refuseSizesOf(fromGrace);
    let asked = sfu.asked.length;
    expect((await watch(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: grace.user.id }]);
    expect(sfu.asked.slice(asked).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromGrace, trackName: "video", simulcast: sizeOf("a") }] } },
      { path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromGrace, trackName: "video" }] } },
      { path: `/sessions/${pictures}/renegotiate`, body: expect.anything() as unknown },
    ]);
    expect(warned).toHaveBeenCalledExactlyOnceWith("The Realtime SFU didn't send a huddle's camera in the size asked for:", "invalid_params");
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({
      sessionId: pictures,
      heard: [
        { mid: "0", from: fromAda, kind: "video", size: "a" },
        { mid: "1", from: fromGrace, kind: "video" },
      ],
      unsized: true,
    });
    // Ada's stays in the size it's in, however the tab shows them from then on: the SFU is asked nothing.
    asked = sfu.asked.length;
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect(sfu.asked).toHaveLength(asked);
    // Which the connection keeps to as it stops watching a camera that went off.
    graces.send({ type: "huddle.unpublish", kind: "video" });
    await reached(graces);
    expect(await watchSmall(linuses, [ada.user.id, grace.user.id])).toBeNull();
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video", size: "a" }], unsized: true });

    // The tab's next connection asks by size again, and a camera the SFU no longer finds is no size refused.
    sfu.sessions.get(fromAda)!.published.clear();
    asked = sfu.asked.length;
    expect(await watchSmall(linuses, [ada.user.id], true)).toBeNull();
    expect(sfu.asked.at(-1)!.body).toEqual({ tracks: [{ location: "remote", sessionId: fromAda, trackName: "video", simulcast: sizeOf("b") }] });
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: newest(sfu), heard: [] });
    expect(warned).toHaveBeenCalledOnce();
  });

  it("asks at once, without a size, for a camera the SFU won't send in the size asked for and offers a tab nothing with: a tab with no connection yet would ask by size again, and never be shown it", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("unsized-at-once");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    sfu.refuseSizesOf(fromAda);

    // A tab makes its connection of an offer, and Linus's is offered her camera in the round that asked for it.
    let asked = sfu.asked.length;
    expect((await watch(linuses, [ada.user.id], true))!.tracks).toEqual([{ mid: "0", kind: "video", userId: ada.user.id }]);
    const pictures = newest(sfu);
    expect(sfu.asked.slice(asked).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/sessions/new", body: null },
      { path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video", simulcast: sizeOf("a") }] } },
      { path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video" }] } },
      { path: `/sessions/${pictures}/renegotiate`, body: expect.anything() as unknown },
    ]);
    expect(warned).toHaveBeenCalledExactlyOnceWith("The Realtime SFU didn't send a huddle's camera in the size asked for:", "invalid_params");
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video" }], unsized: true });

    // The connection asks for no sizes from then on.
    asked = sfu.asked.length;
    expect((await watchSmall(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: grace.user.id }]);
    expect(sfu.asked[asked]!.body).toEqual({ tracks: [{ location: "remote", sessionId: fromGrace, trackName: "video" }] });
  });

  it("leaves a camera the SFU won't send in the size asked for to the tab's next round when it offers the tab another with it, which the tab answers first", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("unsized-next-round");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    const fromGrace = await showing(sfu, graces, inSizes());
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    sfu.refuseSizesOf(fromGrace);

    // The session takes nothing more until the tab has answered the offer of Ada's, which comes in the size asked for.
    let asked = sfu.asked.length;
    expect((await watchSmall(linuses, [ada.user.id, grace.user.id], true))!.tracks).toEqual([{ mid: "0", kind: "video", userId: ada.user.id }]);
    const pictures = newest(sfu);
    expect(sfu.asked.slice(asked).map(({ path }) => path)).toEqual(["/sessions/new", `/sessions/${pictures}/tracks/new`, `/sessions/${pictures}/renegotiate`]);
    expect(warned).toHaveBeenCalledExactlyOnceWith("The Realtime SFU didn't send a huddle's camera in the size asked for:", "invalid_params");
    expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: pictures, heard: [{ mid: "0", from: fromAda, kind: "video", size: "b" }], unsized: true });

    // The tab has a connection by then, so its next round asks on it, where Grace's is asked for without a size.
    asked = sfu.asked.length;
    expect((await watchSmall(linuses, [ada.user.id, grace.user.id]))!.tracks).toEqual([{ mid: "1", kind: "video", userId: grace.user.id }]);
    expect(sfu.asked.slice(asked).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/sessions/${pictures}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromGrace, trackName: "video" }] } },
      { path: `/sessions/${pictures}/renegotiate`, body: expect.anything() as unknown },
    ]);
    expect(warned).toHaveBeenCalledOnce();
  });

  it("asks for cameras again without sizes when the SFU refuses the whole request that asked for them in sizes, and lets go of the connection as ever when it refuses that too, or didn't answer", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("sizes-refused");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await showing(sfu, adas, inSizes());
    // Grace's camera is sent in one size.
    const fromGrace = await showing(sfu, graces);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sized = { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video", simulcast: sizeOf("a") }] };
    const unsized = { tracks: [{ location: "remote", sessionId: fromAda, trackName: "video" }] };
    const pulling = /\/tracks\/new$/;
    /** What the SFU was asked to pull, of the last `count` things it was asked. */
    const pulledSince = (count: number) => sfu.asked.slice(count).flatMap(({ path, body }) => (pulling.test(path) ? [body] : []));
    /** Has Linus's tab ask to watch `people` on a fresh connection, and answers the SFU's pulls for it once the room has told it that it failed. */
    async function refusedWatching(people: Session[]) {
      const asked = sfu.asked.length;
      linuses.send({ type: "huddle.listen", kind: "video", watch: people.map(({ user }) => user.id), fresh: true });
      expect(await linuses.next("error")).toEqual(failed("huddle.listen", "video"));
      expect((await remembered(room))[2]!.cameras).toEqual({});
      return pulledSince(asked);
    }

    // By whatever status it refuses with, since it doesn't say which it would for its sizes, or by an error code in place of its answer.
    const refusals: Array<[() => void, string]> = [
      [() => sfu.refuse(pulling, 406, "invalid_params"), "The Realtime SFU answered 406 (invalid_params)"],
      [() => sfu.answerInstead(pulling, () => new Response("Service Unavailable", { status: 503 })), "The Realtime SFU answered 503"],
      [() => sfu.answerInstead(pulling, () => Response.json({ errorCode: "invalid_params", errorDescription: "No such size" })), "The Realtime SFU answered 200 (invalid_params)"],
    ];
    for (const [refuse, logged] of refusals) {
      refuse();
      const asked = sfu.asked.length;
      expect((await watch(linuses, [ada.user.id], true))!.tracks).toEqual([{ mid: "0", kind: "video", userId: ada.user.id }]);
      expect(pulledSince(asked)).toEqual([sized, unsized]);
      expect(warned).toHaveBeenLastCalledWith("The Realtime SFU didn't take a request for a huddle's cameras in sizes:", logged);
      expect((await remembered(room))[2]!.cameras!.receiving).toEqual({ sessionId: newest(sfu), heard: [{ mid: "0", from: fromAda, kind: "video" }], unsized: true });
    }

    // Refused without sizes too, the tab hears that it failed, and starts over.
    sfu.refuse(pulling, 406, "invalid_params");
    sfu.refuse(pulling, 406, "invalid_params");
    expect(await refusedWatching([ada])).toEqual([sized, unsized]);
    // The room can't tell what a session carries once the SFU didn't answer, or answered what it can't read, so it asks nothing more of it.
    sfu.answerInstead(pulling, () => Promise.reject(new TypeError("Network connection lost")));
    expect(await refusedWatching([ada])).toEqual([sized]);
    sfu.answerInstead(pulling, () => new Response("<html>"));
    expect(await refusedWatching([ada])).toEqual([sized]);
    // And a request that asked for no sizes has none to leave out.
    sfu.refuse(pulling, 406, "invalid_params");
    expect(await refusedWatching([grace])).toEqual([{ tracks: [{ location: "remote", sessionId: fromGrace, trackName: "video" }] }]);
  });
});

describe("Screens shared in a huddle", () => {
  it("publishes the screen a tab shares on a session of its own, beside its microphone's and its camera's, and has the others hear they can watch it once its connection has connected", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("screen");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const voice = await publishing(sfu, adas);
    const picture = await showing(sfu, adas);
    await graces.next("huddle.changed");
    await graces.next("huddle.changed");
    const asked = sfu.asked.length;

    adas.send(screen("Ada's screen"));
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "screen", sdp: "answer to Ada's screen" });
    const shared = sfu.publishers.at(-1)!;
    expect([voice, picture]).not.toContain(shared);
    expect(sfu.asked.slice(asked)).toEqual([
      { appId: APP.appId, method: "POST", path: "/sessions/new", body: null },
      {
        appId: APP.appId,
        method: "POST",
        path: `/sessions/${shared}/tracks/new`,
        sessionId: shared,
        body: { sessionDescription: { type: "offer", sdp: "Ada's screen" }, tracks: [{ location: "local", mid: "0", trackName: "screen" }] },
      },
    ]);
    // Nobody can watch it until her tab says that connection has connected, which saying so of her camera's isn't.
    adas.send({ type: "huddle.connected", kind: "video" });
    await reached(adas, graces);
    expect(graces.pending("huddle.changed")).toEqual([]);
    adas.send({ type: "huddle.connected", kind: "screen" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true, video: true, screen: true }) });
    expect((await (await joinHuddle(room, await signIn("Linus"))).next("huddle.welcome")).people[0]).toEqual(person(ada, { audio: true, video: true, screen: true }));

    // None of it touched what carries her voice or her camera.
    expect([closedOn(sfu, voice), closedOn(sfu, picture)]).toEqual([[], []]);
    expect((await remembered(room))[0]).toMatchObject({
      publishing: { sessionId: voice },
      cameras: { publishing: { sessionId: picture } },
      screens: { publishing: { sessionId: shared, tracks: [{ mid: "0", kind: "screen" }], connectedAt: expect.any(Number) as number } },
    });

    // She stops sharing: the others hear they can't watch it, and the SFU closes it alone.
    adas.send({ type: "huddle.unpublish", kind: "screen" });
    expect(await graces.next("huddle.changed")).toEqual({ type: "huddle.changed", person: person(ada, { audio: true, video: true }) });
    await vi.waitFor(() => expect(closedOn(sfu, shared)).toEqual(["0"]));
    expect([closedOn(sfu, voice), closedOn(sfu, picture)]).toEqual([[], []]);
    expect((await remembered(room))[0]!.screens).toEqual({});
  });

  it("offers a tab the screens it asks to watch, on a session of its own, has the SFU close one it no longer asks for, and keeps it all while the room hibernates", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("watching-screens");
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    for (const socket of [adas, graces]) await publishMicrophone(socket);
    await showing(sfu, adas);
    const fromAda = await sharing(sfu, adas);
    await sharing(sfu, graces);
    await listen(linuses, true);
    const voices = newest(sfu);
    await watch(linuses, [ada.user.id], true);
    const pictures = newest(sfu);

    // Asked for nobody's, he's offered nobody's, and the SFU is asked nothing.
    const asked = sfu.asked.length;
    expect(await watch(linuses, [], false, "screen")).toBeNull();
    expect(sfu.asked).toHaveLength(asked);

    expect(await watch(linuses, [ada.user.id], false, "screen")).toEqual({ type: "huddle.offer", kind: "screen", sdp: expect.any(String) as string, tracks: [{ mid: "0", kind: "screen", userId: ada.user.id }] });
    const screens = newest(sfu);
    expect([voices, pictures]).not.toContain(screens);
    // Her screen, and not her camera, which is another session's.
    expect(sfu.asked.at(-2)).toMatchObject({ path: `/sessions/${screens}/tracks/new`, body: { tracks: [{ location: "remote", sessionId: fromAda, trackName: "screen" }] } });
    expect((await watch(linuses, [ada.user.id, grace.user.id], false, "screen"))!.tracks).toEqual([{ mid: "1", kind: "screen", userId: grace.user.id }]);

    const before = await remembered(room);
    await evictDurableObject(roomStub(room));
    expect(await remembered(room)).toEqual(before);
    expect(before[2]).toMatchObject({
      receiving: { sessionId: voices, heard: [{ kind: "audio" }, { kind: "audio" }] },
      cameras: { receiving: { sessionId: pictures, heard: [{ kind: "video" }] } },
      screens: { receiving: { sessionId: screens, heard: [{ mid: "0", from: fromAda, kind: "screen" }, { mid: "1", kind: "screen" }] } },
    });

    // Asking for Grace's alone has the SFU close Ada's, and nothing he hears or watches of their cameras.
    expect(await watch(linuses, [grace.user.id], false, "screen")).toBeNull();
    expect(closedOn(sfu, screens)).toEqual(["0"]);
    expect([closedOn(sfu, voices), closedOn(sfu, pictures)]).toEqual([[], []]);
  });

  it("shows two screens, and refuses the next until one of them stops", async () => {
    const { sfu } = await huddlesOn();
    const room = await freshRoom("screens-full");
    const [first, second, third, fourth] = (await crowd(room, 4)) as [HuddleSocket, HuddleSocket, HuddleSocket, HuddleSocket];
    await publishScreen(first);
    await publishScreen(second);

    // One more is refused before the SFU is asked anything, which its tab hears as its screen not being shared.
    const asked = sfu.asked.length;
    third.send(screen("one screen too many"));
    expect(await third.next("error")).toEqual({ type: "error", message: SCREENS_FULL, failed: "huddle.publish", kind: "screen", refused: true });
    expect(sfu.asked).toHaveLength(asked);
    // Their camera is another matter, and so is a screen shared anew from a tab that shares one.
    await publishCamera(third);
    await publishScreen(first, "the first screen again");

    // Once one stops there's room for one, and only one, even when two ask while the SFU answers the first.
    first.send({ type: "huddle.unpublish", kind: "screen" });
    await reached(first);
    const started = sfu.askedTo(/sessions\/new$/).length;
    const release = sfu.hold(/sessions\/new$/);
    third.send(screen("the screen after"));
    await vi.waitFor(() => expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(started + 1));
    await publishScreen(fourth);
    release();
    expect(await third.next("error")).toMatchObject({ message: SCREENS_FULL, kind: "screen", refused: true });
    // What the SFU made for it meanwhile is closed.
    await vi.waitFor(() => expect(closedOn(sfu, newest(sfu))).toEqual(["0"]));
    expect((await remembered(room)).map(({ screens }) => screens?.publishing !== undefined)).toEqual([false, true, false, true]);
  });

  it("stops the screens people share once its check hears that an administrator has screen sharing off, ahead of the cameras a check takes down with them", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("screens-off");
    const sockets = await crowd(room, 10);
    const cameras: string[] = [];
    for (const socket of sockets) cameras.push(await showing(sfu, socket));
    // The last two to have joined share their screens.
    const sharers = sockets.slice(8);
    const shared = [await sharing(sfu, sharers[0]!), await sharing(sfu, sharers[1]!)];
    const watcher = sockets[0]!;
    await reached(watcher);
    const heard = watcher.log.length;
    const stillOn = async () => {
      const everyone = await remembered(room);
      return [everyone.filter(({ screens }) => screens?.publishing).length, everyone.filter(({ cameras }) => cameras?.publishing).length];
    };

    // Each tab hears why its screen stopped, the others that they can't watch it, and the SFU closes it. The cameras stay on.
    await switchScreens(ada, false);
    await ring(room);
    for (const socket of sharers) expect(await socket.next("error")).toEqual(SCREEN_OFF);
    await vi.waitFor(() => expect(shared.map((id) => closedOn(sfu, id))).toEqual([["0"], ["0"]]));
    await reached(watcher);
    const changed = watcher.log.slice(heard).filter(({ type }) => type === "huddle.changed");
    expect(changed).toEqual([8, 9].map((n) => ({ type: "huddle.changed", person: { user: { id: `person-${n}`, name: `Person ${n}` }, muted: false, audio: false, video: true, screen: false } })));
    expect(await stillOn()).toEqual([0, 10]);
    expect(cameras.map((id) => closedOn(sfu, id))).toEqual(cameras.map(() => []));

    // One that asks is refused before the SFU is asked anything.
    const asked = sfu.asked.length;
    sharers[0]!.send(screen("a screen while they're off"));
    expect(await sharers[0]!.next("error")).toEqual(SCREEN_OFF);
    expect(sfu.asked).toHaveLength(asked);

    // On again, screens are shared as before.
    await switchScreens(ada, true);
    await ring(room);
    const again = [await sharing(sfu, sharers[0]!, "a screen once they're on"), await sharing(sfu, sharers[1]!, "another")];
    expect(await stillOn()).toEqual([2, 10]);

    // With cameras off as well, a check takes down eight in all, the screens first, and the next the cameras left.
    await switchScreens(ada, false);
    await switchCameras(ada, false);
    await ring(room);
    for (const socket of sharers) expect(await socket.next("error")).toEqual(SCREEN_OFF);
    for (const socket of sockets.slice(0, 6)) expect(await socket.next("error")).toEqual(CAMERA_OFF);
    await vi.waitFor(() => expect(again.map((id) => closedOn(sfu, id))).toEqual([["0"], ["0"]]));
    expect(await stillOn()).toEqual([0, 4]);
    await ring(room);
    for (const socket of sockets.slice(6)) expect(await socket.next("error")).toEqual(CAMERA_OFF);
    expect(await stillOn()).toEqual([0, 0]);
  });

  it("refuses a screen the SFU was still answering for when its check heard that screen sharing is off", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("screens-off-late");
    const adas = await welcomed(room, ada);
    const started = sfu.askedTo(/sessions\/new$/).length;
    const release = sfu.hold(/sessions\/new$/);
    adas.send(screen("Ada's screen"));
    await vi.waitFor(() => expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(started + 1));
    await switchScreens(ada, false);
    // Nothing of hers is shared for the check to stop.
    await ring(room);
    release();
    expect(await adas.next("error")).toEqual(SCREEN_OFF);
    // What the SFU made for it meanwhile is closed.
    await vi.waitFor(() => expect(closedOn(sfu, newest(sfu))).toEqual(["0"]));
    expect((await remembered(room))[0]!.screens?.publishing).toBeUndefined();
  });

  it("has the SFU close everything a tab sent and received, on all six of its connections, once it leaves", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("leaving-screens");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const adasOwn = [await publishing(sfu, adas), await showing(sfu, adas), await sharing(sfu, adas)];
    const gracesOwn = [await publishing(sfu, graces), await showing(sfu, graces), await sharing(sfu, graces)];
    await listen(graces, true);
    gracesOwn.push(newest(sfu));
    await watch(graces, [ada.user.id], true);
    gracesOwn.push(newest(sfu));
    await watch(graces, [ada.user.id], true, "screen");
    gracesOwn.push(newest(sfu));
    expect(new Set(gracesOwn).size).toBe(6);

    graces.leave();
    await vi.waitFor(() => expect(gracesOwn.map((id) => closedOn(sfu, id))).toEqual(gracesOwn.map(() => ["0"])));
    expect(adasOwn.map((id) => closedOn(sfu, id))).toEqual([[], [], []]);
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
  });

  it("has the SFU close microphones, then cameras, then screens when a huddle ends with its room", async () => {
    const { ada, sfu } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Short-lived", { as: ada })).id;
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const adasScreen = await sharing(sfu, adas);
    const [adasVoice, adasPicture] = [await publishing(sfu, adas), await showing(sfu, adas)];
    const gracesVoice = await publishing(sfu, graces);
    await watch(graces, [ada.user.id], true, "screen");
    const asked = sfu.asked.length;

    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    await vi.waitFor(() => expect(sfu.asked).toHaveLength(asked + 4));
    await sleep(20);
    expect(sfu.asked.slice(asked).map(({ path }) => path)).toEqual([adasVoice, gracesVoice, adasPicture, adasScreen].map((id) => `/sessions/${id}/tracks/close`));
  });

  it("asks the SFU about a tab's screen without waiting on its camera, and tells it which of the two the SFU refused", async () => {
    const { ada, sfu } = await huddlesOn();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = await freshRoom("screen-in-turn");
    const adas = await welcomed(room, ada);

    const release = sfu.hold(/sessions\/new$/);
    adas.send(camera("Ada's camera"));
    await vi.waitFor(() => expect(sfu.askedTo(/sessions\/new$/)).toHaveLength(1));
    adas.send(screen("Ada's screen"));
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "screen", sdp: "answer to Ada's screen" });
    release();
    expect(await adas.next("huddle.published")).toEqual({ type: "huddle.published", kind: "video", sdp: "answer to Ada's camera" });

    // A screen the SFU doesn't take isn't shared, and her camera stays as it was.
    sfu.refuse(/tracks\/new$/);
    adas.send(screen("Ada's second screen"));
    expect(await adas.next("error")).toEqual(failed("huddle.publish", "screen"));
    expect(warned).toHaveBeenLastCalledWith("A huddle's huddle.publish failed:", "The Realtime SFU answered 500 (internal_error)");
    expect((await remembered(room))[0]).toMatchObject({ cameras: { publishing: { tracks: [{ kind: "video" }] } }, screens: { publishing: { tracks: [{ kind: "screen" }] } } });
  });
});

describe("Who a huddle is for", () => {
  it("lets in only the room's members, signed in, from the app's own pages", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const open = await freshRoom("open");
    const leads = (await createRoom("Leads", { closedTo: [ada.user.id], as: ada })).id;

    expect((await api(`/api/rooms/${open}/huddle`, upgrade())).status).toBe(401);
    expect((await api(`/api/rooms/${open}/huddle`, { headers: { Cookie: ada.cookie } })).status).toBe(404);
    expect((await api(`/api/rooms/${open}/huddle`, { headers: { ...upgrade(ada.cookie).headers, Origin: "https://elsewhere.example" } })).status).toBe(404);
    expect((await api("/api/rooms/no%20such%20room/huddle", upgrade(ada.cookie))).status).toBe(404);
    // A room that isn't there for someone closes their socket at once, as its own socket does, without waking the room.
    expect(await (await joinHuddle(leads, grace)).closed).toMatchObject({ code: CloseCode.NotFound, reason: "NotFound" });
    expect(await runInDurableObject(roomStub(leads), (_room, state: DurableObjectState) => state.getWebSockets())).toEqual([]);
    expect((await (await joinHuddle(leads, ada)).next("huddle.welcome")).people).toEqual([person(ada)]);
  });

  it("takes the room's own socket for nothing else, whatever its request says of a huddle", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("headers");
    const response = await api(`/api/rooms/${room}/socket?protocol=${ROOM_PROTOCOL}`, { headers: { ...upgrade(ada.cookie).headers, [HUDDLE_HEADER]: "true" } });
    const ws = response.webSocket!;
    const first = new Promise<{ type: string }>((resolve) => ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string) as { type: string }), { once: true }));
    ws.accept();
    expect((await first).type).toBe("welcome");
    expect(await remembered(room)).toEqual([]);
  });

  it("takes whoever loses the room out of its huddle, telling the others they left, and has the SFU close their tracks", async () => {
    const { ada, sfu } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const fromGrace = await publishing(sfu, graces);
    await publishing(sfu, adas);
    await listen(graces, true);
    const toGrace = newest(sfu);

    const takenOut = await api(`/api/rooms/${room}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "closed", memberIds: [ada.user.id] }) });
    expect(takenOut.status).toBe(200);
    expect(await graces.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    await vi.waitFor(() => expect([closedOn(sfu, fromGrace), closedOn(sfu, toGrace)]).toEqual([["0"], ["0"]]));
    // The room isn't there for her any more, nor its huddle.
    expect(await (await joinHuddle(room, grace)).closed).toMatchObject({ code: CloseCode.NotFound });
    await reached(adas);
    expect(adas.pending("huddle.joined")).toHaveLength(1);
  });

  it("ignores what a socket sent before it heard it was closed", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("late");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);

    await roomStub(room).revoke(room, [{ tag: grace.user.id, code: CloseCode.Revoked }], Date.now());
    graces.send({ type: "huddle.mute", muted: true });

    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    await reached(adas);
    expect(adas.pending("huddle.changed")).toEqual([]);
  });

  it("takes someone who leaves the room out of its huddle too", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);

    expect((await api(`/api/rooms/${room}/membership`, { method: "DELETE", headers: { Cookie: grace.cookie } })).status).toBe(204);
    expect(await graces.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    expect(await (await joinHuddle(room, grace)).closed).toMatchObject({ code: CloseCode.NotFound });
  });

  it("takes someone out of the huddles they're in when they sign out", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("signing-out");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    expect((await api("/api/session", { method: "DELETE", headers: { Cookie: grace.cookie } })).status).toBe(204);
    expect(await graces.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    expect((await api(`/api/rooms/${room}/huddle`, upgrade(grace.cookie))).status).toBe(401);
  });

  it("turns away a socket the Workspace let through before its person lost the room, or too long ago to trust", async () => {
    await huddlesOn();
    const room = await freshRoom("revoked");
    const user = { id: "u1", name: "Grace" };
    const revokedAt = Date.now();
    await roomStub(room).revoke(room, [{ tag: sessionTag("laptop"), code: CloseCode.Reconnect }], revokedAt);
    const reconnect = { code: CloseCode.Reconnect, reason: "Reconnect" };
    expect(await (await forwardHuddle(room, { user, sessionId: "laptop", authorizedAt: revokedAt })).closed).toMatchObject(reconnect);
    expect(await (await forwardHuddle(room, { user, sessionId: "phone", authorizedAt: revokedAt - 10 * 60 * 1000 })).closed).toMatchObject(reconnect);
    expect(await remembered(room)).toEqual([]);
    const later = await forwardHuddle(room, { user, sessionId: "laptop", authorizedAt: revokedAt + 1 });
    expect((await later.next("huddle.welcome")).you).toEqual(user);
  });

  it("keeps an address a ban blocks out of huddles, and takes it out of the ones it's in", async () => {
    const { ada } = await huddlesOn();
    const banned = "203.0.113.7";
    const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
    const joined = await api(`/api/join/${joinCode}`, {
      method: "POST",
      headers: { "CF-Connecting-IP": banned },
      body: JSON.stringify({ name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler pioneer" }),
    });
    expect(joined.status, await joined.clone().text()).toBe(201);
    const grace = ((await joined.json()) as { user: Me }).user;
    const room = await freshRoom("banned");
    // Hal, who shares her address.
    const hal = { ...(await signIn("Hal")), ip: banned };
    const adas = await welcomed(room, ada);
    const hals = await welcomed(room, hal);
    await adas.next("huddle.joined");

    expect((await api(`/api/users/${grace.id}/ban`, { method: "POST", headers: { Cookie: ada.cookie } })).status).toBe(200);
    expect((await hals.closed).code).toBe(CloseCode.Reconnect);
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: hal.user.id });
    // He can read the room still, but not be heard in it.
    expect((await connect(room, hal)).welcome.you).toEqual(hal.user);
    expect(await (await joinHuddle(room, hal)).closed).toMatchObject({ code: CloseCode.NotFound, reason: "NotFound" });
    // Nor does the room take the Worker's word for a socket from such an address.
    const forwarded = await forwardHuddle(room, { user: hal.user, sessionId: "s1", authorizedAt: Date.now(), address: banned, banned: true });
    expect(await forwarded.closed).toMatchObject({ code: CloseCode.NotFound });
    await reached(adas);
    expect(adas.pending("huddle.joined")).toEqual([]);
  });

  it("ends a huddle with its room, having the SFU close what its people published", async () => {
    const { ada, sfu } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = (await createRoom("Short-lived", { as: ada })).id;
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const linuses = await welcomed(room, linus);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    await listen(graces, true);
    const toGrace = newest(sfu);
    const asked = sfu.asked.length;

    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    for (const socket of [adas, graces, linuses]) expect(await socket.closed).toMatchObject({ code: CloseCode.NotFound, reason: "NotFound" });
    // Nobody was left to hear who went.
    expect([...adas.pending("huddle.left"), ...graces.pending("huddle.left"), ...linuses.pending("huddle.left")]).toEqual([]);
    // A tab that kept its connections open is heard by nobody: a request for each of those who published, and none for what anyone heard.
    await vi.waitFor(() => expect([closedOn(sfu, fromAda), closedOn(sfu, fromGrace)]).toEqual([["0"], ["0"]]));
    await sleep(20);
    expect(sfu.asked.slice(asked).map(({ path }) => path)).toEqual([`/sessions/${fromAda}/tracks/close`, `/sessions/${fromGrace}/tracks/close`]);
    expect(closedOn(sfu, toGrace)).toEqual([]);
    // With nothing left for the SFU to close, the room's alarm is the one that erases it.
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
    expect(await kept(room, "eraseDue")).toBeUndefined();
    expect(await alarmOf(room)).toBeGreaterThan(Date.now() + HUDDLE_CHECK_MS);
  });

  it("asks the SFU again, from a deleted room's alarm, to close what its huddle published and the SFU didn't, and erases the room after", async () => {
    const { ada, sfu } = await huddlesOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = (await createRoom("Refused", { as: ada })).id;
    const adas = await welcomed(room, ada);
    const fromAda = await publishing(sfu, adas);
    const asked = sfu.asked.length;

    sfu.refuse(/tracks\/close$/, 503, "temporarily_unavailable_error");
    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    await vi.waitFor(async () => expect(await kept(room, "huddleUnclosed")).toMatchObject([{ appId: APP.appId, sessionId: fromAda, mids: ["0"] }]));
    expect(sfu.asked).toHaveLength(asked + 1);
    await vi.waitFor(async () => expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS));

    // Refused again, the alarm comes back for it, and the room stays.
    sfu.refuse(/tracks\/close$/, 503, "temporarily_unavailable_error");
    await ring(room);
    expect(await kept(room, "huddleUnclosed")).toMatchObject([{ sessionId: fromAda }]);
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);
    await ring(room);
    expect(closedOn(sfu, fromAda)).toEqual(["0"]);
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
    expect(await kept(room, "deletedRoom")).toBe(room);
    expect(await alarmOf(room)).toBe(await kept(room, "eraseDue"));
  });
});

describe("The room's check of its huddle", () => {
  it("comes every half minute while someone's in the huddle, and no more once nobody is", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("checking");
    expect(await alarmOf(room)).toBeNull();
    const before = Date.now();
    const adas = await welcomed(room, ada);
    const first = (await alarmOf(room))!;
    expect(first).toBeGreaterThanOrEqual(before + HUDDLE_CHECK_MS);
    expect(first).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);

    await sleep(5);
    await ring(room);
    const second = (await alarmOf(room))!;
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);
    expect(adas.ws.readyState).toBe(WebSocket.OPEN);

    adas.leave();
    await adas.closed;
    await ring(room);
    expect(await alarmOf(room)).toBeNull();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(false);
  });

  it("takes out whoever's socket has gone unheard for a minute and a half, which a tab's pings put off", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("unheard");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const fromAda = await publishing(sfu, adas);
    const graces = await welcomed(room, grace);
    await sleep(20);
    // The app's heartbeat, which the runtime answers without waking the room.
    graces.sendRaw('{"type":"ping"}');
    expect(await graces.next("pong")).toEqual({ type: "pong" });
    const [{ openedAt }] = (await remembered(room)) as [HuddleAttachment, HuddleAttachment];

    await checkAt(room, openedAt + HUDDLE_SILENT_MS);
    expect(adas.ws.readyState).toBe(WebSocket.OPEN);
    await checkAt(room, openedAt + HUDDLE_SILENT_MS + 1);
    expect(await adas.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(await graces.next("huddle.left")).toEqual({ type: "huddle.left", userId: ada.user.id });
    await vi.waitFor(() => expect(closedOn(sfu, fromAda)).toEqual(["0"]));
    expect(graces.ws.readyState).toBe(WebSocket.OPEN);
    expect(await remembered(room)).toMatchObject([{ user: grace.user }]);
  });

  it("takes out six of the unheard a check, and asks the SFU about all their connections no more than the rest of a check leaves an event", async () => {
    const { sfu } = await huddlesOn();
    const room = await freshRoom("unheard-crowd");
    const sockets = await crowd(room, 8);
    const everyone = sockets.map((_, n) => `person-${n}`);
    // Everyone sends and receives all a tab can: a microphone and a camera, the others' voices and cameras, and the screens the first two share.
    for (const socket of sockets) {
      await publishMicrophone(socket);
      await publishCamera(socket);
    }
    for (const socket of sockets.slice(0, 2)) await publishScreen(socket);
    for (const socket of sockets) {
      await listen(socket, true);
      await watch(socket, everyone, true);
      await watch(socket, everyone.slice(0, 2), true, "screen");
    }
    const openedAt = Math.max(...(await remembered(room)).map(({ openedAt }) => openedAt));
    const asked = sfu.asked.length;

    // The first six to have joined: six connections each for the two who share, and five for the rest.
    await checkAt(room, openedAt + HUDDLE_SILENT_MS + 1);
    for (const socket of sockets.slice(0, 6)) expect(await socket.closed).toMatchObject({ code: CloseCode.Reconnect });
    await vi.waitFor(() => expect(sfu.asked.length - asked).toBe(2 * 6 + 4 * 5));
    await sleep(20);
    expect(sfu.asked.slice(asked).every(({ path }) => path.endsWith("/tracks/close"))).toBe(true);
    expect(sfu.asked.length - asked).toBe(32);
    expect((await remembered(room)).map(({ user }) => user.id)).toEqual(["person-6", "person-7"]);
    // And the rest at the next.
    await checkAt(room, openedAt + HUDDLE_SILENT_MS + 1);
    for (const socket of sockets.slice(6)) expect(await socket.closed).toMatchObject({ code: CloseCode.Reconnect });
    expect(await remembered(room)).toEqual([]);
  });

  it("ends a huddle once huddles are turned off, or run through another app", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("turned-off");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    await publishing(sfu, adas);
    let graces = await welcomed(room, grace);

    await giveKeys(ada, OTHER_APP);
    const asked = sfu.asked.length;
    await ring(room);
    // Their tabs connect again, to a huddle that runs through the new app.
    for (const socket of [adas, graces]) expect(await socket.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(sfu.asked).toHaveLength(asked);
    graces = await welcomed(room, grace);
    await publishing(sfu, graces);
    expect(sfu.asked.slice(asked).map(({ appId }) => appId)).toEqual([OTHER_APP.appId, OTHER_APP.appId]);

    expect((await api("/api/account/huddles", { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(200);
    await ring(room);
    expect(await graces.closed).toMatchObject({ code: HuddleCloseCode.Off, reason: "Off" });
    expect(await (await joinHuddle(room, grace)).closed).toMatchObject({ code: HuddleCloseCode.Off });
    expect(await alarmOf(room)).toBeNull();
  });

  it("asks the SFU again to close the tracks it didn't, until it has", async () => {
    const { ada, sfu } = await huddlesOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = await freshRoom("unclosed");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    await listen(graces, true);
    const toGrace = newest(sfu);

    // The SFU refuses one request, and closes nothing it's asked to in the other.
    sfu.refuse(/tracks\/close$/, 503, "temporarily_unavailable_error");
    sfu.answerInstead(/tracks\/close$/, () => Response.json({ tracks: [{ mid: "0", errorCode: "internal_error", errorDescription: "Backend error" }] }));
    graces.leave();
    await adas.next("huddle.left");
    const unclosed = [
      { appId: APP.appId, sessionId: fromGrace, mids: ["0"], since: expect.any(Number) as number },
      { appId: APP.appId, sessionId: toGrace, mids: ["0"], since: expect.any(Number) as number },
    ];
    await vi.waitFor(async () => expect(await kept(room, "huddleUnclosed")).toEqual(unclosed));

    // Still not, at the next check, for one of them.
    sfu.refuse(/tracks\/close$/);
    await ring(room);
    expect(await kept(room, "huddleUnclosed")).toEqual([unclosed[0]]);
    expect(closedOn(sfu, toGrace)).toEqual(["0"]);
    await ring(room);
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
    expect(closedOn(sfu, fromGrace)).toEqual(["0"]);

    // With nobody left in the huddle, the room comes back until the SFU has closed what the last of them published.
    sfu.refuse(/tracks\/close$/);
    adas.leave();
    await vi.waitFor(async () => expect(await kept(room, "huddleUnclosed")).toMatchObject([{ sessionId: fromAda, mids: ["0"] }]));
    sfu.refuse(/tracks\/close$/);
    await ring(room);
    expect(await kept(room, "huddleUnclosed")).toMatchObject([{ sessionId: fromAda }]);
    await ring(room);
    expect(closedOn(sfu, fromAda)).toEqual(["0"]);
    expect(await kept(room, "huddleUnclosed")).toBeUndefined();
    expect(await alarmOf(room)).toBeNull();
  });

  it("keeps the tracks it's asking the SFU about again until it has answered, whatever else is kept meanwhile", async () => {
    const { ada, sfu } = await huddlesOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const room = await freshRoom("asked-again");
    const grace = await signIn("Grace");
    const adas = await welcomed(room, ada);
    const graces = await welcomed(room, grace);
    const fromAda = await publishing(sfu, adas);
    const fromGrace = await publishing(sfu, graces);
    sfu.refuse(/tracks\/close$/);
    graces.leave();
    await vi.waitFor(async () => expect(await kept(room, "huddleUnclosed")).toMatchObject([{ sessionId: fromGrace }]));

    // The SFU is still answering for Grace's tracks when it refuses to close Ada's.
    const answer = sfu.hold(/tracks\/close$/);
    const rung = ring(room);
    await vi.waitFor(() => expect(sfu.askedTo(/tracks\/close$/)).toHaveLength(2));
    sfu.refuse(/tracks\/close$/);
    adas.leave();
    await vi.waitFor(async () => expect(await kept(room, "huddleUnclosed")).toMatchObject([{ sessionId: fromGrace }, { sessionId: fromAda }]));

    answer();
    await rung;
    expect(closedOn(sfu, fromGrace)).toEqual(["0"]);
    expect(await kept(room, "huddleUnclosed")).toMatchObject([{ sessionId: fromAda }]);
  });

  it("leaves the room's logs until they're due, however often it rings meanwhile, and the alarm to them once the huddle is over", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("logs");
    // An upload that's started sets the alarm for a day later, when the room deletes it if it's unfinished still.
    const started = await startUpload(ada, room, { name: "notes.txt", type: "text/plain", size: 10, clientMessageId: crypto.randomUUID() });
    expect(started.status, await started.clone().text()).toBe(201);
    const due = (await alarmOf(room))!;
    expect(due).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(await kept(room, "logsDue")).toBe(due);

    const adas = await welcomed(room, ada);
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);
    await ring(room);
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);
    expect([await kept(room, "logsDue"), await kept(room, "undeliveredRoom")]).toEqual([due, room]);

    // Logs due before the huddle's next check have the alarm ring for them.
    const soon = Date.now() + 5_000;
    await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.put("logsDue", soon));
    await ring(room);
    expect(await alarmOf(room)).toBe(soon);
    // Once due, they're sent, and what's left of them says when it's due: the upload, still.
    await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.put("logsDue", Date.now() - 1));
    await ring(room);
    expect(await kept(room, "logsDue")).toBe(due);
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + HUDDLE_CHECK_MS);

    adas.leave();
    await adas.closed;
    await ring(room);
    expect(await alarmOf(room)).toBe(due);
    expect(await kept(room, "undeliveredRoom")).toBe(room);
  });
});

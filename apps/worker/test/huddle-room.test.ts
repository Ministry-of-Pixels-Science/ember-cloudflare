import { CloseCode, ROOM_PROTOCOL, type Me, type RoomId, type ServerFrame } from "@ember/protocol";
import { CAMERAS_FULL, CAMERAS_OFF, HUDDLE_FAILED, HuddleCloseCode, MAX_HUDDLE_CAMERAS, MAX_HUDDLE_PEOPLE, type HuddlePerson, type HuddleTrackKind } from "@ember/protocol/huddles";
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
  reached,
  ring,
  setUp,
  switchCameras,
  watch,
  welcomed,
  type HuddleSocket,
  type StandInSfu,
} from "./huddle-support";
import { api, connect, createRoom, freshDeploy, freshRoom, post, roomStub, settle, signIn, startUpload, upgrade, workspaceSql, type Session } from "./support";

// A room's huddle: who's in it, and what the room asks of the Realtime SFU for them, which a stand-in
// answers (./huddle-support.ts). Nothing here carries sound: a session description is whatever a test
// says it is, and the stand-in passes it on.

/** Someone in a huddle as the others hear of them: unmuted, and not to be listened to yet, but for `changes`. */
const person = ({ user }: Session, changes: Partial<Omit<HuddlePerson, "user">> = {}): HuddlePerson => ({ user, muted: false, audio: false, video: false, ...changes });

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

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("A room's huddle", () => {
  it("lets the room's members in on a socket of their own, welcomes each with who's in it, and tells the others who joins and leaves", async () => {
    const { ada, sfu } = await huddlesOn();
    const room = await freshRoom("huddle");
    const grace = await signIn("Grace");

    const adas = await joinHuddle(room, ada);
    const welcome = await adas.next("huddle.welcome");
    expect(welcome).toEqual({ type: "huddle.welcome", you: ada.user, people: [person(ada)], startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) as string });

    const graces = await joinHuddle(room, grace, { muted: true });
    expect(await graces.next("huddle.welcome")).toEqual({ type: "huddle.welcome", you: grace.user, people: [person(ada), person(grace, { muted: true })], startedAt: welcome.startedAt });
    expect(await adas.next("huddle.joined")).toEqual({ type: "huddle.joined", person: person(grace, { muted: true }) });

    graces.leave();
    expect(await adas.next("huddle.left")).toEqual({ type: "huddle.left", userId: grace.user.id });
    await graces.closed;
    // Being in a huddle, with nobody's microphone published, asks the SFU nothing.
    expect(sfu.asked).toEqual([]);

    // Once everyone has left, whoever joins next starts another.
    adas.leave();
    await adas.closed;
    await sleep(5);
    const next = await joinHuddle(room, grace);
    const again = await next.next("huddle.welcome");
    expect(again.people).toEqual([person(grace)]);
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

  it("starts a huddle afresh for whoever joins once huddles run through another app", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("another-app");
    const grace = await signIn("Grace");
    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");

    await giveKeys(ada, OTHER_APP);
    // The room goes by what the Workspace last said of the app for half a minute, unless it has restarted since.
    await evictDurableObject(roomStub(room));
    await sleep(5);
    const graces = await joinHuddle(room, grace);
    const welcome = await graces.next("huddle.welcome");
    // Ada's tab connects again, to a huddle that started when Grace joined it.
    expect(await adas.closed).toMatchObject({ code: CloseCode.Reconnect, reason: "Reconnect" });
    expect(welcome.people).toEqual([person(grace)]);
    expect(Date.parse(welcome.startedAt)).toBeGreaterThan(Date.parse(startedAt));
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
      { type: "huddle.publish", sdp: "an offer", tracks: [{ mid: "0", kind: "screen" }] },
      { type: "huddle.publish", sdp: "an offer", tracks: [{ mid: "0", kind: "audio" }, { mid: "1", kind: "video" }] },
      { type: "huddle.listen", fresh: "yes" },
      { type: "huddle.listen", kind: "screen" },
      { type: "huddle.listen", kind: "video", watch: "everyone" },
      { type: "huddle.unpublish", kind: "screen" },
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
    expect(changed).toEqual(sockets.slice(0, 8).map((_, n) => ({ type: "huddle.changed", person: { user: { id: `person-${n}`, name: `Person ${n}` }, muted: false, audio: true, video: false } })));
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

  it("lets cameras go on when the Workspace says nothing of them, as one from before they could be turned off does", async () => {
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
    await ring(room);
    expect((await remembered(room))[0]!.cameras?.publishing).toBeDefined();
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

import type { RoomId, SearchResults } from "@ember/protocol";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRoom } from "../src/chat-room";
import { HUDDLE_RESUMED_MS, HUDDLE_STARTED } from "../src/huddles/message";
import { HUDDLE_TAG, type HuddleAttachment } from "../src/huddles/room";
import { MessageStore } from "../src/store";
import { alarmOf, giveKeys, huddlesOn, joinHuddle, kept, OTHER_APP, ring, setUp, welcomed, type HuddleSocket } from "./huddle-support";
import { api, connect, createRoom, freshDeploy, freshRoom, post, roomSql, roomStub, settle, signIn, workspaceSql, type Session, type Socket } from "./support";

// The message a room keeps of each huddle in it (src/huddles/message.ts), as the room's own sockets hear
// of it: written as the huddle starts, and saying that the huddle is over once nobody is left in it.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A huddle's message as the room tells of it, but for what it says of its huddle: `starter`'s, in `room`. */
const written = (room: RoomId, starter: Session) => ({
  id: expect.any(String) as string,
  clientMessageId: expect.any(String) as string,
  roomId: room,
  creator: starter.user,
  body: `<p>${HUDDLE_STARTED}</p>`,
  plainText: HUDDLE_STARTED,
  mentions: [],
  createdAt: expect.any(String) as string,
  updatedAt: expect.any(String) as string,
  editedAt: null,
  boosts: [],
});

/** Starts a huddle in `room` as `session`, and answers their socket in it, when it started, and the message `watching` hears of it. */
async function started(room: RoomId, session: Session, watching: Socket) {
  const socket = await joinHuddle(room, session);
  const { startedAt } = await socket.next("huddle.welcome");
  const { message, seq } = await watching.next("message.created");
  return { socket, startedAt, message, seq };
}

/** Leaves the huddle on `socket`, as a tab does, and waits until the room has closed it. */
async function left(socket: HuddleSocket): Promise<void> {
  socket.leave();
  await socket.closed;
}

/** Expects `watching` to have heard of no message since the last it read, once the room has done what was asked of it before. */
async function heardNoMore(watching: Socket): Promise<void> {
  await settle(watching);
  expect([...watching.pending("message.created"), ...watching.pending("message.updated")]).toEqual([]);
}

/** Waits until the search index has taken what the room logged for it. */
async function indexed(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/**
 * Waits until the room has sent the search index its log as its first socket has it do, a moment after
 * the socket opens, so that what it logs from then on is sent only if the room says so.
 */
const sentItsFirstLog = (room: RoomId) =>
  runInDurableObject(roomStub(room), (object: unknown) => (object as { couriers: { index: { settled(): Promise<void> } } }).couriers.index.settled());

/** Counts how often a room fails to bring its huddle's message in step, from now on, by what it logs of it. */
function countFailures(): () => number {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => logged.mock.calls.filter(([message]) => message === "Keeping the message of the room's huddle failed:").length;
}

const unreachable = () => new Error("The database is unreachable");

/** Has a write of a huddle's message fail once, though it's saved, as a write to D1 can whose answer is lost. */
function savedUnanswered(): void {
  const create = MessageStore.prototype.createHuddle;
  vi.spyOn(MessageStore.prototype, "createHuddle").mockImplementationOnce(async function (this: MessageStore, ...given) {
    await create.apply(this, given);
    throw unreachable();
  });
}

/** Has the sockets in `room`'s huddle name no message, as those do that joined before a huddle named its message as it started. */
const namingNoMessage = (room: RoomId) =>
  runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
    for (const socket of state.getWebSockets(HUDDLE_TAG)) {
      const { messageId: _, ...attachment } = socket.deserializeAttachment() as HuddleAttachment;
      socket.serializeAttachment(attachment);
    }
  });

type Room = { revocationsFor(roomId: RoomId): unknown; serially(work: () => Promise<unknown>): Promise<unknown> };

/**
 * Has a room be asked for something else, which takes it `ms`, as it lets the next person into its
 * huddle, when it looks up whether their access has ended: that takes its turn after their joining, and
 * before whatever the room hears of its huddle from then on.
 */
function busyAsItLetsIn(ms: number): void {
  const room = ChatRoom.prototype as unknown as Room;
  const revocationsFor = room.revocationsFor;
  vi.spyOn(room, "revocationsFor").mockImplementationOnce(function (this: Room, roomId) {
    void this.serially(() => sleep(ms));
    return revocationsFor.call(this, roomId);
  });
}

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("A huddle's message in its room", () => {
  it("is written as a huddle starts, in the name of whoever started it, and says nothing new as others join", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);

    const { startedAt, message } = await started(room, ada, watching);
    // Its text is all that a tab from before huddles had messages shows of it, and what a bot reads.
    expect(message).toEqual({ ...written(room, ada), huddle: { startedAt } });
    expect(message.updatedAt).toBe(message.createdAt);
    await welcomed(room, grace);
    await heardNoMore(watching);
    // Whoever opens the room later finds it among the room's messages.
    expect((await connect(room, grace)).welcome.messages).toEqual([message]);
  });

  it("is named to everyone as they join its huddle, for its thread to be the huddle's, and stays the one it was while the huddle goes on", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const named = async (socket: HuddleSocket) => (await socket.next("huddle.welcome")).messageId;

    const adas = await joinHuddle(room, ada);
    const messageId = await named(adas);
    expect((await watching.next("message.created")).message.id).toBe(messageId);
    const graces = await joinHuddle(room, grace);
    expect(await named(graces)).toBe(messageId);

    // Back within half a minute of its end, Ada goes on with the huddle it was, under the message it had.
    await left(graces);
    await left(adas);
    await watching.next("message.updated");
    const back = await joinHuddle(room, ada);
    expect(await named(back)).toBe(messageId);
    await left(back);

    // The huddle Grace starts later is another, with a message of its own.
    vi.setSystemTime(Date.now() + HUDDLE_RESUMED_MS + 1);
    const later = await named(await joinHuddle(room, grace));
    expect(later).not.toBe(messageId);
    expect((await watching.next("message.created")).message.id).toBe(later);
  });

  it("marks the room unread for nobody, as a message someone writes there does", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("quiet");
    const watching = await connect(room, ada);
    const unread = () => workspaceSql("SELECT user_id FROM memberships WHERE room_id = ? AND unread_at IS NOT NULL", room);

    await started(room, ada, watching);
    // By the time the search index has the message, the Workspace would have heard of one logged for it.
    await indexed(room);
    expect(await roomSql(room, "SELECT kind FROM room_events WHERE room_id = ? AND message_id IS NOT NULL", room)).toEqual([]);
    expect(await unread()).toEqual([]);

    await post(watching, "Anyone joining?");
    await vi.waitFor(async () => expect(await unread()).toContainEqual({ user_id: linus.user.id }));
  });

  it("writes nothing for someone the huddle turns away", async () => {
    const ada = await setUp();
    const room = await freshRoom("off");
    const watching = await connect(room, ada);

    // Huddles are off: nobody has given Ember an SFU app's keys.
    await (await joinHuddle(room, ada)).closed;
    await heardNoMore(watching);
    expect(await kept(room, "huddleMessage")).toBeUndefined();
  });

  it("says that the huddle is over once the last person has left, when it ended, and who was in it", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const { socket: adas, startedAt, message, seq } = await started(room, ada, watching);
    const graces = await welcomed(room, grace);
    // Someone who moves to another tab was in it once.
    const moved = await welcomed(room, ada);
    await adas.closed;

    await left(graces);
    await heardNoMore(watching);
    await left(moved);
    const over = await watching.next("message.updated");
    const { endedAt } = over.message.huddle!;
    expect(over).toEqual({ type: "message.updated", seq: seq + 1, message: { ...message, updatedAt: endedAt, huddle: { startedAt, endedAt, people: [ada.user, grace.user] } } });
    expect(Date.parse(endedAt!)).toBeGreaterThanOrEqual(Date.parse(startedAt));
    expect((await connect(room, grace)).welcome.messages).toEqual([over.message]);

    // The alarm that checked the huddle has nothing left to come back for.
    await ring(room);
    expect(await alarmOf(room)).toBeNull();
    await heardNoMore(watching);
  });

  it("keeps its thread and its reactions as the huddle ends", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const { socket: adas, startedAt, message } = await started(room, ada, tab);

    tab.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Notes from the huddle</p>", parentId: message.id });
    const { thread } = (await tab.next("message.updated")).message;
    expect(thread).toMatchObject({ count: 1 });
    tab.send({ type: "boost.create", messageId: message.id, content: "👍" });
    const { boost } = await tab.next("boost.created");

    await left(adas);
    expect((await tab.next("message.updated")).message).toMatchObject({ id: message.id, thread, boosts: [boost], huddle: { startedAt, people: [ada.user] } });
  });

  it("goes on as the huddle it was for someone back in it within half a minute, and starts another for anyone else, or later", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const { socket: adas, startedAt, message } = await started(room, ada, watching);
    await left(adas);
    expect((await watching.next("message.updated")).message.huddle).toMatchObject({ people: [ada.user] });

    // Ada's tab, which had lost its connection, is back: the huddle goes on from when it started, and so does its message.
    vi.setSystemTime(Date.now() + HUDDLE_RESUMED_MS);
    const back = await joinHuddle(room, ada);
    expect((await back.next("huddle.welcome")).startedAt).toBe(startedAt);
    expect((await watching.next("message.updated")).message).toEqual({ ...message, updatedAt: expect.any(String) as string, huddle: { startedAt } });
    const graces = await welcomed(room, grace);
    await left(back);
    await left(graces);
    expect((await watching.next("message.updated")).message).toMatchObject({ id: message.id, huddle: { startedAt, people: [ada.user, grace.user] } });

    // Linus wasn't in it, so his is another huddle, with a message of its own.
    vi.setSystemTime(Date.now() + 1);
    const { socket: linuses, startedAt: later, message: second } = await started(room, linus, watching);
    expect(Date.parse(later)).toBeGreaterThan(Date.parse(startedAt));
    expect(second).toEqual({ ...written(room, linus), huddle: { startedAt: later } });
    expect(second.id).not.toBe(message.id);
    await left(linuses);
    expect((await watching.next("message.updated")).message).toMatchObject({ id: second.id, huddle: { people: [linus.user] } });

    // And so is the one he starts once half a minute has passed.
    vi.setSystemTime(Date.now() + HUDDLE_RESUMED_MS + 1);
    const { message: third } = await started(room, linus, watching);
    expect([message.id, second.id]).not.toContain(third.id);
    await heardNoMore(watching);
  });

  it("goes on as it was when everyone connects again because huddles run through another app", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("another-app");
    const watching = await connect(room, linus);
    const { socket: adas, startedAt, message } = await started(room, ada, watching);

    await giveKeys(ada, OTHER_APP);
    // The room goes by what the Workspace last said of the app for half a minute, unless it has restarted since.
    await evictDurableObject(roomStub(room));
    const graces = await joinHuddle(room, grace);
    expect(await graces.next("huddle.welcome")).toMatchObject({ startedAt, messageId: message.id });
    await adas.closed;
    const back = await welcomed(room, ada);
    await heardNoMore(watching);

    await left(graces);
    await left(back);
    expect((await watching.next("message.updated")).message).toMatchObject({ id: message.id, huddle: { startedAt, people: [ada.user, grace.user] } });
  });

  it("counts whoever was in the huddle as who's in it changed, though they've left again by the time the room gets to its message", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    // The room is asked for something else as it lets Ada in, and she has left by the time it gets to her joining.
    busyAsItLetsIn(250);

    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    await left(adas);
    const { message } = await watching.next("message.created");
    expect(message).toEqual({ ...written(room, ada), huddle: { startedAt } });
    expect((await watching.next("message.updated")).message).toMatchObject({ id: message.id, huddle: { startedAt, people: [ada.user] } });
  });

  it("gives a huddle that was going on before rooms kept messages of them its message as the next person joins", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("updated");
    const watching = await connect(room, linus);
    const { startedAt, message } = await started(room, ada, watching);
    // As after an update: the room's object, which starts afresh, has kept nothing of the huddle that its sockets are in, and they name no message.
    await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.delete("huddleMessage"));
    await namingNoMessage(room);
    await evictDurableObject(roomStub(room));

    // Whoever joins it is named none either, though it gets one.
    const graces = await joinHuddle(room, grace);
    expect(await graces.next("huddle.welcome")).not.toHaveProperty("messageId");
    const { message: late } = await watching.next("message.created");
    expect(late).toEqual({ ...written(room, ada), huddle: { startedAt } });
    expect(late.id).not.toBe(message.id);
  });

  it("is written with the room's next check of the huddle when it couldn't be as the huddle started", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const failures = countFailures();
    vi.spyOn(MessageStore.prototype, "createHuddle").mockRejectedValueOnce(unreachable());

    const adas = await joinHuddle(room, ada);
    const { startedAt, messageId } = await adas.next("huddle.welcome");
    await heardNoMore(watching);
    expect(failures()).toBe(1);
    // Another message's deletion meanwhile leaves the huddle's to be written.
    watching.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Wrong room</p>" });
    watching.send({ type: "message.delete", messageId: (await watching.next("message.created")).message.id });
    await watching.next("message.deleted");
    await ring(room);
    // It's the message Ada's tab was named as she joined.
    expect((await watching.next("message.created")).message).toEqual({ ...written(room, ada), id: messageId, huddle: { startedAt } });
    expect(failures()).toBe(1);
  });

  it("tells the room of a message whose write failed and was saved all the same, and writes no second one", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    countFailures();
    const create = MessageStore.prototype.createHuddle;
    vi.spyOn(MessageStore.prototype, "createHuddle").mockImplementationOnce(async function (this: MessageStore, ...given) {
      await create.apply(this, given);
      throw unreachable();
    });

    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    await heardNoMore(watching);
    await ring(room);
    const { message } = await watching.next("message.created");
    expect(message).toEqual({ ...written(room, ada), huddle: { startedAt } });
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([{ id: message.id }]);
    await heardNoMore(watching);
  });

  it("is written saying that the huddle is over when it couldn't be as the huddle started, and nobody is left in it by the room's next check", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const failures = countFailures();
    vi.spyOn(MessageStore.prototype, "createHuddle").mockRejectedValueOnce(unreachable());

    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    await heardNoMore(watching);
    await left(adas);
    const { message } = await watching.next("message.created");
    expect(message).toEqual({ ...written(room, ada), huddle: { startedAt, endedAt: message.createdAt, people: [ada.user] } });
    // Nothing is left for the check to make up for.
    await ring(room);
    await heardNoMore(watching);
    expect([failures(), await alarmOf(room)]).toEqual([1, null]);
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([{ id: message.id }]);
    // Back in it within half a minute, Ada finds it the huddle it was, as its message says from then.
    expect((await (await joinHuddle(room, ada)).next("huddle.welcome")).startedAt).toBe(startedAt);
    expect((await watching.next("message.updated")).message).toEqual({ ...message, updatedAt: expect.any(String) as string, huddle: { startedAt } });
  });

  it("says that the huddle is over, though the room never heard of it, when its write failed, was saved all the same, and nobody is left by the next check", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    countFailures();
    savedUnanswered();

    const adas = await joinHuddle(room, ada);
    const { startedAt } = await adas.next("huddle.welcome");
    await heardNoMore(watching);
    // Whoever opens the room meanwhile finds the message nobody was told of, of a huddle that's going on.
    const [saved] = (await connect(room, ada)).welcome.messages;
    expect(saved).toEqual({ ...written(room, ada), huddle: { startedAt } });
    await left(adas);
    const { message } = await watching.next("message.created");
    expect(message).toEqual({ ...saved, updatedAt: expect.any(String) as string, huddle: { startedAt, endedAt: message.updatedAt, people: [ada.user] } });
    await ring(room);
    await heardNoMore(watching);
    expect((await connect(room, ada)).welcome.messages).toEqual([message]);
  });

  it("says that a huddle is over with a later check when it couldn't as the last person left, though the room's object has started afresh since", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const failures = countFailures();
    const { socket: adas, startedAt, message } = await started(room, ada, watching);
    vi.spyOn(MessageStore.prototype, "updateHuddle").mockRejectedValueOnce(unreachable()).mockRejectedValueOnce(unreachable());

    await left(adas);
    await heardNoMore(watching);
    expect(failures()).toBe(1);
    // The alarm comes back for as long as the message is behind.
    await ring(room);
    expect([failures(), await alarmOf(room)]).toEqual([2, expect.any(Number)]);
    // An object that starts afresh remembers only what it stored: the message, which it hasn't found over.
    await evictDurableObject(roomStub(room));
    await ring(room);
    expect((await watching.next("message.updated")).message).toMatchObject({ id: message.id, huddle: { startedAt, people: [ada.user] } });
    expect([failures(), await alarmOf(room)]).toEqual([2, null]);
  });

  it("tells the room that a huddle is over though the message of the one going on can't be written then", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus] = [await signIn("Grace"), await signIn("Linus")];
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    const failures = countFailures();
    const { startedAt, message } = await started(room, ada, watching);
    // The room's object keeps the message as that of an earlier huddle it hasn't found over, and the one going on has yet to name its own: no join leaves it with either.
    const earlier = new Date(Date.parse(startedAt) - 60_000).toISOString();
    await runInDurableObject(roomStub(room), async (_room, state: DurableObjectState) => state.storage.put("huddleMessage", { ...(await state.storage.get<object>("huddleMessage")), startedAt: earlier }));
    await namingNoMessage(room);
    await evictDurableObject(roomStub(room));
    vi.spyOn(MessageStore.prototype, "createHuddle").mockRejectedValueOnce(unreachable());

    await welcomed(room, grace);
    expect((await watching.next("message.updated")).message).toMatchObject({ id: message.id, huddle: { startedAt: earlier, people: [ada.user] } });
    await heardNoMore(watching);
    expect(failures()).toBe(1);
    await ring(room);
    const { message: second } = await watching.next("message.created");
    expect(second).toEqual({ ...written(room, ada), huddle: { startedAt } });
    expect(second.id).not.toBe(message.id);
  });

  it("can't be edited, by whoever started the huddle or by an administrator", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const [adasTab, gracesTab] = [await connect(room, ada), await connect(room, grace)];
    const { message } = await started(room, grace, adasTab);

    for (const tab of [gracesTab, adasTab]) {
      tab.send({ type: "message.update", messageId: message.id, body: "<p>Nothing happened here</p>" });
      expect(await tab.next("error")).toEqual({ type: "error", message: "A huddle's message can't be edited.", failed: "message.update" });
    }
    await heardNoMore(adasTab);
  });

  it("is deleted as any message is, and says nothing of its huddle from then on, nor does one kept for its thread's replies", async () => {
    const { ada } = await huddlesOn();
    const failures = countFailures();
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const { socket: adas, message } = await started(room, ada, tab);
    tab.send({ type: "message.delete", messageId: message.id });
    expect(await tab.next("message.deleted")).toMatchObject({ messageId: message.id });
    await left(adas);
    await heardNoMore(tab);

    // One with replies in its thread keeps its place for them, without its huddle.
    const other = await freshRoom("retro");
    const otherTab = await connect(other, ada);
    const { socket: again, message: second } = await started(other, ada, otherTab);
    otherTab.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Notes from the huddle</p>", parentId: second.id });
    await otherTab.next("message.created");
    await otherTab.next("message.updated");
    otherTab.send({ type: "message.delete", messageId: second.id });
    const place = (await otherTab.next("message.updated")).message;
    expect(place).toMatchObject({ id: second.id, deleted: true, plainText: "" });
    expect(place.huddle).toBeUndefined();
    await left(again);
    await heardNoMore(otherTab);
    expect(failures()).toBe(0);
  });

  it("stays deleted when it's deleted before the room has heard that it was written", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const failures = countFailures();
    savedUnanswered();
    const adas = await joinHuddle(room, ada);
    await adas.next("huddle.welcome");
    await heardNoMore(tab);

    // Ada opens the room again, finds the message nobody was told of, and deletes it before the room's next check.
    const [saved] = (await connect(room, ada)).welcome.messages;
    tab.send({ type: "message.delete", messageId: saved!.id });
    expect(await tab.next("message.deleted")).toMatchObject({ messageId: saved!.id });
    await ring(room);
    await left(adas);
    await heardNoMore(tab);
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([]);
    expect(failures()).toBe(1);
  });

  it("goes with its room, whose object keeps nothing of it once the room is deleted", async () => {
    const { ada } = await huddlesOn();
    const room = (await createRoom("Short-lived", { as: ada })).id;
    const tab = await connect(room, ada);
    const { socket: adas, startedAt, message } = await started(room, ada, tab);
    expect(await kept(room, "huddleMessage")).toEqual({ roomId: room, messageId: message.id, startedAt, people: [ada.user], posted: true });

    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    await adas.closed;
    await sleep(20);
    expect(await kept(room, "huddleMessage")).toBeUndefined();
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([]);
  });

  it("isn't written in a room that's deleted by the time the room gets to it, with someone still in its huddle as someone else left", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await createRoom("Short-lived", { as: ada })).id;
    const tab = await connect(room, ada);
    const { socket: adas } = await started(room, ada, tab);
    // The room is deleted before it gets to Grace's joining, and Grace leaves before it has done either.
    busyAsItLetsIn(300);
    const graces = await welcomed(room, grace);
    const deleting = api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } });
    await sleep(100);
    await left(graces);

    expect((await deleting).status).toBe(204);
    await adas.closed;
    await sleep(20);
    expect(await kept(room, "huddleMessage")).toBeUndefined();
    expect(await roomSql(room, "SELECT id FROM messages WHERE room_id = ?", room)).toEqual([]);
  });

  it("is found by a search for what it says, which shows it as it is by then: of a huddle that's going on, and once that's over, of one that is", async () => {
    const { ada } = await huddlesOn();
    const linus = await signIn("Linus");
    const room = await freshRoom("standup");
    const watching = await connect(room, linus);
    await sentItsFirstLog(room);
    const found = async () => ((await (await api("/api/searches?q=huddle", { headers: { Cookie: linus.cookie } })).json()) as SearchResults).matches.map(({ message }) => message);

    const { socket: adas, message } = await started(room, ada, watching);
    await indexed(room);
    expect(await found()).toEqual([message]);

    await left(adas);
    const over = (await watching.next("message.updated")).message;
    await indexed(room);
    expect(await found()).toEqual([over]);
  });
});

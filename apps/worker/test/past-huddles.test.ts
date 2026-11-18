import type { Involvement, Message, RoomId, ServerFrame } from "@ember/protocol";
import { PAST_HUDDLES_LISTED, type PastHuddle, type PastHuddles } from "@ember/protocol/huddles";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../src/chat-room";
import { HUDDLE_RESUMED_MS, type HuddleNow } from "../src/huddles/message";
import { MIGRATIONS } from "../src/migrations";
import type { HuddleChange } from "../src/room-log";
import { MessageStore } from "../src/store";
import { Workspace } from "../src/workspace";
import { alarmOf, huddlesOn, kept, reached, welcomed, type HuddleSocket } from "./huddle-support";
import { api, connect, createRoom, direct, freshDeploy, freshRoom, openWorkspaceSocket, post, roomSql, roomStub, signIn, workspaceSql, workspaceStub, type Session, type Socket, type WorkspaceSocket } from "./support";

// The huddles that are over, as the Huddles page lists them (`GET /api/huddles`): each room sends the
// Workspace its huddles' messages as they come to say their huddles are over, and as their threads gain
// and lose replies (src/room-log.ts), and the Workspace lists them for everyone in the room.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The huddles the Huddles page lists for `session`'s person. */
const listFor = async (session: Session) => ((await (await api("/api/huddles", { headers: { Cookie: session.cookie } })).json()) as PastHuddles).huddles;

/** What the room has logged for the Workspace's list, and the Workspace hasn't taken. */
const logged = (room: RoomId) => roomSql(room, "SELECT message_id FROM changed_huddles WHERE room_id = ? ORDER BY seq", room);

/** Waits until the Workspace has taken what the room logged for its list. */
async function taken(room: RoomId): Promise<void> {
  while ((await logged(room)).length > 0) await sleep(5);
}

/** Waits until the room has no call out to the Workspace for its list, nor one to make. */
const sentItsHuddles = (room: RoomId) =>
  runInDurableObject(roomStub(room), (object: unknown) => (object as { couriers: { huddles: { settled(): Promise<void> } } }).couriers.huddles.settled());

/** The message of the huddle that starts in a room, as `watching` hears of it. */
async function huddleMessage(watching: Socket): Promise<Message> {
  for (;;) {
    const { message } = await watching.next("message.created");
    if (message.huddle) return message;
  }
}

/** The next frame changing message `id` that `client` hears. */
async function updated(client: Socket, id: string): Promise<Extract<ServerFrame, { type: "message.updated" }>> {
  for (;;) {
    const frame = await client.next("message.updated");
    if (frame.message.id === id) return frame;
  }
}

/** A huddle's message as `watching` hears that its huddle is over. */
async function ended(watching: Socket, { id }: Pick<Message, "id">): Promise<Message> {
  for (;;) {
    const { message } = await updated(watching, id);
    if (message.huddle?.endedAt !== undefined) return message;
  }
}

/** A huddle's message as `watching` hears that its huddle goes on after all. */
async function resumed(watching: Socket, { id }: Pick<Message, "id">): Promise<Message> {
  for (;;) {
    const { message } = await updated(watching, id);
    if (message.huddle && message.huddle.endedAt === undefined) return message;
  }
}

/** Leaves the huddle on `socket`, as a tab does, and waits until the room has closed it. */
async function left(socket: HuddleSocket): Promise<void> {
  socket.leave();
  await socket.closed;
}

/** Has `people` hold a huddle in `room`, which the first of them starts and they leave in turn, and answers its message as `watching` hears that it's over. */
async function held(room: RoomId, watching: Socket, ...people: Session[]): Promise<Message> {
  const sockets: HuddleSocket[] = [];
  for (const person of people) sockets.push(await welcomed(room, person));
  const message = await huddleMessage(watching);
  for (const socket of sockets) await left(socket);
  return ended(watching, message);
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

/** Deletes `message` as `client`, and waits for the room to say it's gone. */
async function removed(client: Socket, { id }: Pick<Message, "id">): Promise<void> {
  client.send({ type: "message.delete", messageId: id });
  while ((await client.next("message.deleted")).messageId !== id);
}

/** When the huddle `message` is of started and ended, and who was in it: `people`, in the order they joined. */
const overOf = (message: Message, people: Session[]): NonNullable<HuddleChange["over"]> => ({
  startedAt: message.huddle!.startedAt,
  endedAt: message.huddle!.endedAt!,
  userIds: people.map(({ user }) => user.id),
});

/** A huddle that's over as the page lists it: `message`'s, in `room`, which `people` were in. */
const past = (room: RoomId, message: Message, people: Session[], replies = 0): PastHuddle => ({ roomId: room, messageId: message.id, ...overOf(message, people), replies });

/** Gives `session`'s person `involvement` in room `roomId`, as their bell does. */
async function involve(session: Session, roomId: RoomId, involvement: Involvement): Promise<void> {
  const response = await api(`/api/rooms/${roomId}/involvement`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ involvement }) });
  expect(response.status).toBe(200);
}

/** Waits until `tab` hears that the list of huddles changed, past whatever else it hears first. */
async function heardChange(tab: WorkspaceSocket): Promise<void> {
  while ((await tab.next()).type !== "huddles.changed");
}

/** Expects the Workspace to have sent `tab` nothing but the answer to a ping sent now. */
const heardNothing = async (tab: WorkspaceSocket) => expect(await tab.answers()).toBe(true);

/** The minute `n` of a day, as an ISO time. */
const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("The huddles that are over", () => {
  it("are listed for everyone in their room, in the huddle or not, and for nobody else, once they're over", async () => {
    const { ada } = await huddlesOn();
    const [grace, linus, margaret] = [await signIn("Grace"), await signIn("Linus"), await signIn("Margaret")];
    const { id: room } = await createRoom("standup", { as: ada, closedTo: [ada.user.id, grace.user.id, linus.user.id] });
    const watching = await connect(room, linus);
    const [linussTab, margaretsTab] = [await openWorkspaceSocket(linus), await openWorkspaceSocket(margaret)];

    const adas = await welcomed(room, ada);
    const message = await huddleMessage(watching);
    const graces = await welcomed(room, grace);
    // One going on is in nobody's list: the sidebar has it.
    await sentItsHuddles(room);
    expect(await listFor(ada)).toEqual([]);

    await left(graces);
    await left(adas);
    const over = await ended(watching, message);
    await heardChange(linussTab);
    const listed = [past(room, over, [ada, grace])];
    expect(await listFor(ada)).toEqual(listed);
    expect(await listFor(linus)).toEqual(listed);
    expect(await listFor(margaret)).toEqual([]);
    await taken(room);
    await heardNothing(margaretsTab);
  });

  it("are listed for nobody who isn't signed in", async () => {
    expect((await api("/api/huddles")).status).toBe(401);
  });

  it("have one whose message the room could only write once it was over", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const tab = await connect(room, grace);
    // The room finds two in a huddle it has no message of, as in one that went on while Ember was updated, and can't write one for as long as it goes on.
    const create = MessageStore.prototype.createHuddle;
    vi.spyOn(MessageStore.prototype, "createHuddle").mockImplementation(async function (this: MessageStore, ...given) {
      if (given[3].endedAt === undefined) throw new Error("The database is unreachable");
      return create.apply(this, given);
    });
    const keepMessage = (huddle: HuddleNow | null) =>
      runInDurableObject(roomStub(room), (object: unknown) => (object as { keepHuddleMessage(huddle: HuddleNow | null): Promise<boolean> }).keepHuddleMessage(huddle));
    expect(await keepMessage({ roomId: room, startedAt: minute(0), people: [ada.user, grace.user] })).toBe(false);
    expect(await keepMessage(null)).toBe(true);

    const over = await huddleMessage(tab);
    expect(over.huddle).toEqual({ startedAt: minute(0), endedAt: over.createdAt, people: [ada.user, grace.user] });
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace])]);
  });

  it("leave out one nobody else joined, as Slack's do, but for as long as its thread has a reply", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = (await direct(ada, grace)).id;
    const tab = await connect(room, ada);
    // Its message stays in the room for Grace, whom Ada invites as a direct message's huddle does, and who doesn't join.
    const adas = await welcomed(room, ada);
    const message = await huddleMessage(tab);
    adas.send({ type: "huddle.invite", userIds: [grace.user.id] });
    await reached(adas);
    await left(adas);
    const over = await ended(tab, message);
    await taken(room);
    expect(await listFor(ada)).toEqual([]);

    const first = await reply(tab, over, "<p>Notes to self</p>");
    await taken(room);
    expect(await listFor(ada)).toEqual([past(room, over, [ada], 1)]);
    const second = await reply(tab, over, "<p>And another</p>");
    await taken(room);
    expect(await listFor(ada)).toEqual([past(room, over, [ada], 2)]);

    await removed(tab, first);
    await taken(room);
    expect(await listFor(ada)).toEqual([past(room, over, [ada], 1)]);
    await removed(tab, second);
    await taken(room);
    expect(await listFor(ada)).toEqual([]);
  });

  it("count the replies in their threads, those written while the huddle went on too, and keep one others joined once its last reply goes", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const adas = await welcomed(room, ada);
    const message = await huddleMessage(tab);
    const graces = await welcomed(room, grace);
    const during = await reply(tab, message, "<p>Notes from the huddle</p>");
    await left(graces);
    await left(adas);
    const over = await ended(tab, message);
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace], 1)]);

    await removed(tab, during);
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace])]);
  });

  it("lose one that goes on after all, whatever replies its thread has, and have it again as it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const tab = await connect(room, grace);
    const over = await held(room, tab, ada, grace);
    await reply(tab, over, "<p>Notes</p>");
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace], 1)]);

    // Ada's tab, which had lost its connection, is back within half a minute: the huddle goes on.
    vi.setSystemTime(Date.now() + HUDDLE_RESUMED_MS - 1_000);
    const back = await welcomed(room, ada);
    expect((await resumed(tab, over)).huddle).toEqual({ startedAt: over.huddle!.startedAt });
    await taken(room);
    expect(await listFor(grace)).toEqual([]);

    vi.setSystemTime(Date.now() + 60_000);
    await left(back);
    const again = await ended(tab, over);
    expect(Date.parse(again.huddle!.endedAt!)).toBeGreaterThan(Date.parse(over.huddle!.endedAt!));
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, again, [ada, grace], 1)]);
  });

  it("lose one whose message is deleted, and one whose message is kept only for its thread's replies", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const first = await held(room, tab, ada, grace);
    // Long enough after it for the next to be another huddle.
    vi.setSystemTime(Date.now() + HUDDLE_RESUMED_MS + 1);
    const second = await held(room, tab, ada, grace);
    expect(second.id).not.toBe(first.id);
    await reply(tab, second, "<p>Notes</p>");
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, second, [ada, grace], 1), past(room, first, [ada, grace])]);

    await removed(tab, first);
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, second, [ada, grace], 1)]);

    // Its thread keeps its place in the room, without what it said of its huddle.
    tab.send({ type: "message.delete", messageId: second.id });
    while ((await updated(tab, second.id)).message.deleted !== true);
    await taken(room);
    expect(await listFor(grace)).toEqual([]);
  });

  it("are the latest to have started in someone's rooms, the latest first, as many as the page lists", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const [busy, quiet] = [await freshRoom("busy"), await freshRoom("quiet")];
    const { id: graces } = await createRoom("graces", { as: grace, closedTo: [grace.user.id] });
    const change = (n: number): HuddleChange => ({
      messageId: `m${String(n).padStart(3, "0")}`,
      over: { startedAt: minute(n), endedAt: minute(n + 1), userIds: [ada.user.id, grace.user.id] },
      replies: n % 3,
    });
    const numbers = Array.from({ length: PAST_HUDDLES_LISTED + 10 }, (_, index) => index + 1);
    // Every tenth is the quiet room's, and the three after them all are in a room Ada isn't in.
    const roomOf = (n: number) => (n > numbers.length ? graces : n % 10 === 0 ? quiet : busy);
    const later = [numbers.length + 1, numbers.length + 2, numbers.length + 3];
    await workspaceStub().applyHuddleChanges(busy, numbers.filter((n) => roomOf(n) === busy).map(change));
    await workspaceStub().applyHuddleChanges(quiet, numbers.filter((n) => roomOf(n) === quiet).map(change));
    await workspaceStub().applyHuddleChanges(graces, later.map(change));
    const listed = (n: number): PastHuddle => ({ roomId: roomOf(n), messageId: change(n).messageId, ...change(n).over!, replies: n % 3 });

    const latestFirst = [...numbers].reverse();
    expect(await listFor(ada)).toEqual(latestFirst.slice(0, PAST_HUDDLES_LISTED).map(listed));
    expect(await listFor(grace)).toEqual([...later.reverse(), ...latestFirst].slice(0, PAST_HUDDLES_LISTED).map(listed));
  });

  it("leave out those of a room someone has hidden from their sidebar, however many it has had, so their other rooms' are listed, and have them again once it's shown, if only muted", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const [busy, quiet] = [await freshRoom("busy"), await freshRoom("quiet")];
    const change = (n: number): HuddleChange => ({ messageId: `m${String(n).padStart(3, "0")}`, over: { startedAt: minute(n), endedAt: minute(n + 1), userIds: [ada.user.id, grace.user.id] }, replies: 0 });
    // The quiet room's two came first, and the busy room has had as many since as the page lists.
    const numbers = Array.from({ length: PAST_HUDDLES_LISTED + 2 }, (_, index) => index + 1);
    const roomOf = (n: number) => (n > 2 ? busy : quiet);
    await workspaceStub().applyHuddleChanges(quiet, numbers.filter((n) => roomOf(n) === quiet).map(change));
    await workspaceStub().applyHuddleChanges(busy, numbers.filter((n) => roomOf(n) === busy).map(change));
    const listed = (n: number): PastHuddle => ({ roomId: roomOf(n), messageId: change(n).messageId, ...change(n).over!, replies: 0 });
    const busys = [...numbers].reverse().slice(0, PAST_HUDDLES_LISTED).map(listed);
    expect(await listFor(ada)).toEqual(busys);

    await involve(ada, busy, "invisible");
    expect(await listFor(ada)).toEqual([2, 1].map(listed));
    expect(await listFor(grace)).toEqual(busys);

    await involve(ada, busy, "nothing");
    expect(await listFor(ada)).toEqual(busys);
  });

  it("tell everyone in the room that they changed, on each of their tabs, and nobody when the room says again what it said", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const { id: room } = await createRoom("standup", { as: ada, closedTo: [ada.user.id, grace.user.id] });
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];
    const linussTab = await openWorkspaceSocket(linus);
    const heard = async () => {
      for (const tab of tabs) expect(await tab.next()).toEqual({ type: "huddles.changed" });
    };
    const nobodyHeard = async () => {
      for (const tab of [...tabs, linussTab]) await heardNothing(tab);
    };
    const over = { startedAt: minute(1), endedAt: minute(2), userIds: [ada.user.id, grace.user.id] };

    await workspaceStub().applyHuddleChanges(room, [{ messageId: "m1", over, replies: 0 }]);
    await heard();
    // A call whose answer the room never had is made again.
    await workspaceStub().applyHuddleChanges(room, [{ messageId: "m1", over, replies: 0 }]);
    await nobodyHeard();
    await workspaceStub().applyHuddleChanges(room, [{ messageId: "m1", over, replies: 1 }]);
    await heard();
    expect(await listFor(grace)).toEqual([{ roomId: room, messageId: "m1", ...over, replies: 1 }]);
    // So is whatever else it says anew of one that's listed: who was in it, when it ended, and when it started.
    const reordered = { ...over, userIds: [grace.user.id, ada.user.id] };
    const longer = { ...reordered, endedAt: minute(3) };
    const earlier = { ...longer, startedAt: minute(0) };
    for (const said of [reordered, longer, earlier]) {
      await workspaceStub().applyHuddleChanges(room, [{ messageId: "m1", over: said, replies: 1 }]);
      await heard();
      expect(await listFor(grace)).toEqual([{ roomId: room, messageId: "m1", ...said, replies: 1 }]);
    }
    // One going on has nothing to take off the list, nor has one nobody else joined.
    await workspaceStub().applyHuddleChanges(room, [
      { messageId: "m2", over: null, replies: 3 },
      { messageId: "m3", over: { ...over, userIds: [ada.user.id] }, replies: 0 },
    ]);
    await nobodyHeard();
    await workspaceStub().applyHuddleChanges(room, [{ messageId: "m1", over: null, replies: 1 }]);
    await heard();
    expect(await listFor(grace)).toEqual([]);
    await nobodyHeard();
  });

  it("keep a room's huddle from what another room says of a message by its id", async () => {
    const ada = await signIn("Ada");
    const [room, other] = [await freshRoom("standup"), await freshRoom("other")];
    const over = { startedAt: minute(1), endedAt: minute(2), userIds: [ada.user.id, "someone-else"] };
    await workspaceStub().applyHuddleChanges(room, [{ messageId: "m1", over, replies: 0 }]);

    await workspaceStub().applyHuddleChanges(other, [{ messageId: "m1", over: { ...over, endedAt: minute(9) }, replies: 4 }]);
    await workspaceStub().applyHuddleChanges(other, [{ messageId: "m1", over: null, replies: 0 }]);
    expect(await listFor(ada)).toEqual([{ roomId: room, messageId: "m1", ...over, replies: 0 }]);
  });

  it("go with their room as it's deleted, as does what the room had yet to send, and have none a room that's gone sends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const { id: room } = await createRoom("standup", { as: ada });
    const tab = await connect(room, ada);
    const over = await held(room, tab, ada, grace);
    await taken(room);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace])]);
    // A reply the Workspace couldn't be told of waits in the room's log.
    vi.spyOn(Workspace.prototype, "applyHuddleChanges").mockRejectedValueOnce(new Error("The Workspace is unreachable"));
    await reply(tab, over, "<p>Notes</p>");
    await vi.waitFor(async () => expect(await kept(room, "undeliveredRoom")).toBe(room), { timeout: 5_000 });
    expect(await logged(room)).toEqual([{ message_id: over.id }]);

    expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: ada.cookie } })).status).toBe(204);
    expect(await logged(room)).toEqual([]);
    expect(await workspaceSql("SELECT message_id FROM past_huddles")).toEqual([]);
    expect(await listFor(grace)).toEqual([]);
    // What a room sends once it's gone lists nothing, and fails nothing.
    await workspaceStub().applyHuddleChanges(room, [{ messageId: over.id, over: overOf(over, [ada, grace]), replies: 0 }]);
    expect(await workspaceSql("SELECT message_id FROM past_huddles")).toEqual([]);
  });

  it("have the huddles there were before they were listed, each once, as their rooms are next opened", async () => {
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    await post(tab, "Before any huddle");
    const over = await held(room, tab, ada, grace);
    await taken(room);
    // As an update from before the list finds things: the huddle's message in its room, and nothing listed.
    await workspaceSql("DELETE FROM past_huddles");
    const fillLog = /INSERT INTO changed_huddles[^;]+/.exec(MIGRATIONS.find(({ name }) => name === "0075_changed_huddles.sql")!.sql)![0];
    await roomSql(room, fillLog);
    // And twice, as a message logged again before the room sends its log is.
    await roomSql(room, fillLog);
    expect(await logged(room)).toEqual([{ message_id: over.id }, { message_id: over.id }]);
    expect(await listFor(grace)).toEqual([]);

    const applied = vi.spyOn(Workspace.prototype, "applyHuddleChanges");
    await evictDurableObject(roomStub(room));
    await connect(room, grace);
    await taken(room);
    expect(applied.mock.calls).toEqual([[room, [{ messageId: over.id, over: overOf(over, [ada, grace]), replies: 0 }]]]);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace])]);
  });

  it("hear nothing from a room of a thread that isn't of a huddle that's over, nor of other messages deleted", async () => {
    const { ada } = await huddlesOn();
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const applied = vi.spyOn(Workspace.prototype, "applyHuddleChanges");

    const question = await post(tab, "Shall we ship it?");
    const answer = await reply(tab, question, "<p>Yes</p>");
    await removed(tab, answer);
    await removed(tab, question);
    // A huddle going on: the replies in its thread are counted once it's over.
    const adas = await welcomed(room, ada);
    const message = await huddleMessage(tab);
    await removed(tab, await reply(tab, message, "<p>Notes</p>"));
    await reply(tab, message, "<p>More notes</p>");
    await sentItsHuddles(room);
    expect(applied).not.toHaveBeenCalled();

    await left(adas);
    const over = await ended(tab, message);
    await taken(room);
    expect(applied.mock.calls).toEqual([[room, [{ messageId: message.id, over: overOf(over, [ada]), replies: 1 }]]]);
    expect(await listFor(ada)).toEqual([past(room, over, [ada], 1)]);
  });

  it("are told what a room has to say once the Workspace can be reached, after a call that failed and the alarm's that failed after it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ada } = await huddlesOn();
    const grace = await signIn("Grace");
    const room = await freshRoom("standup");
    const tab = await connect(room, ada);
    const unreachable = () => new Error("The Workspace is unreachable");
    vi.spyOn(Workspace.prototype, "applyHuddleChanges").mockRejectedValueOnce(unreachable()).mockRejectedValueOnce(unreachable());
    const alarm = () => runInDurableObject(roomStub(room), (instance: ChatRoom) => instance.alarm());

    const over = await held(room, tab, ada, grace);
    // The room has set its alarm to send the log again.
    await vi.waitFor(async () => expect(await kept(room, "undeliveredRoom")).toBe(room), { timeout: 5_000 });
    expect(errors).toHaveBeenCalledWith(`Could not send room ${room}'s huddles to the Workspace; trying again later`, expect.any(Error));
    expect(await logged(room)).toEqual([{ message_id: over.id }]);
    expect(await listFor(grace)).toEqual([]);

    // The alarm's call fails too, which leaves the log for the alarm to come for again.
    await alarm();
    expect(await kept(room, "undeliveredRoom")).toBe(room);
    expect(await alarmOf(room)).not.toBeNull();
    expect(await logged(room)).toEqual([{ message_id: over.id }]);
    expect(await listFor(grace)).toEqual([]);

    await alarm();
    expect(await logged(room)).toEqual([]);
    expect(await listFor(grace)).toEqual([past(room, over, [ada, grace])]);
  });
});

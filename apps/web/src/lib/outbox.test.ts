import { CloseCode, MAX_CHECKED_MESSAGES, type Message, type ServerFrame, type User } from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handOver, leftUnsent, takeBack } from "./outbox";
import { OFFLINE_AFTER_MS } from "./reconnecting-socket";
import { initialRoomState, type PendingMessage } from "./room-state";

/** Stands in for the browser's WebSocket; tests play the server and the network. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: this.closedWith }));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(frame: ServerFrame) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** Closes as the network or the room does: 1006 when the connection drops. */
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }

  sentOfType(type: string) {
    return this.sent.filter((frame) => frame.type === type);
  }
}

const ada: User = { id: "u1", name: "Ada" };
const grace: User = { id: "u2", name: "Grace" };

const socket = () => FakeSocket.all.at(-1)!;
const wait = (ms: number) => vi.advanceTimersByTime(ms);
/** Once the views going have handed over, and those opening taken back, as when React has run their effects. */
const effectsRun = () => Promise.resolve();
const welcome = (you = ada, messages: Message[] = []): ServerFrame => ({ type: "welcome", you, messages, present: [you], hasMore: false, hasNewer: false, around: null, seq: 0 });

/** A message Ada sent, that the room hasn't confirmed. */
const sent = (body: string, overrides: Partial<PendingMessage> = {}): PendingMessage => ({
  id: body,
  clientMessageId: body,
  roomId: "general",
  creator: ada,
  body,
  plainText: body,
  mentions: [],
  createdAt: "2026-10-31T10:00:00.000Z",
  updatedAt: "2026-10-31T10:00:00.000Z",
  editedAt: null,
  boosts: [],
  pending: true,
  ...overrides,
});
/** One Ada wrote while the room was away. */
const waiting = (body: string, overrides: Partial<PendingMessage> = {}) => sent(body, { queued: true, ...overrides });
/** The room's copy of `m`. */
const stored = ({ pending: _, queued: __, ...m }: PendingMessage): Message => ({ ...m, id: `stored-${m.clientMessageId}` });

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: back-off delays come out exact
});

afterEach(() => {
  // What a test leaves in the outbox goes with it.
  for (const roomId of ["general", "random"]) for (const parentId of [undefined, "m1"]) for (const me of [ada, grace]) takeBack(roomId, me, parentId);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("What a view leaves unsent", () => {
  const messages = [
    waiting("written while away"),
    sent("sent before the room let the view in again", { sentOver: 1 }),
    sent("taken back"),
    sent("sent since", { sentOver: 2 }),
    sent("refused", { failed: true }),
    sent("a.txt", { upload: { name: "a.txt", size: 1, percent: 50 } }),
  ];

  it("is what was written while the room was away, and what went without the room saying it has it, but for what went over the socket open now", () => {
    const left = leftUnsent({ ...initialRoomState, status: "open", connections: 2, messages });
    expect(left.map((m) => m.body)).toEqual(["written while away", "sent before the room let the view in again", "taken back"]);
  });

  it.each(["connecting", "reconnecting"] as const)("is all of that while %s, as what went over the socket that closed may never have reached the room", (status) => {
    const left = leftUnsent({ ...initialRoomState, status, connections: 2, messages });
    expect(left.map((m) => m.body)).toEqual(["written while away", "sent before the room let the view in again", "taken back", "sent since"]);
  });

  it("is nothing in a room that's gone, which shows what was waiting as not sent", () => {
    expect(leftUnsent({ ...initialRoomState, status: "gone", messages: [sent("sent")] })).toEqual([]);
  });
});

describe("Send what was left unsent", () => {
  it("sends what was waiting once the room lets its own socket in, replies to their threads, and closes once the room has it all", async () => {
    const message = waiting("Written while away");
    const reply = waiting("In the cupboard", { parentId: "m1", alsoSent: true });
    handOver("general", [message, reply]);
    await effectsRun();
    // A hidden tab's, so that the room reads nothing for it.
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/socket?visible=0&protocol=4");

    socket().open();
    expect(socket().sent).toEqual([]);
    socket().receive(welcome());
    expect(socket().sent).toEqual([
      { type: "message.create", clientMessageId: "Written while away", body: "Written while away" },
      { type: "message.create", clientMessageId: "In the cupboard", body: "In the cupboard", parentId: "m1", alsoSend: true },
    ]);

    socket().receive({ type: "message.created", message: stored(message), seq: 1 });
    expect(socket().closedWith).toBeUndefined();
    socket().receive({ type: "message.created", message: stored(reply), seq: 2 });
    expect(socket().closedWith).toBe(1000);
    expect(takeBack("general", ada)).toEqual([]);
  });

  it("takes one by someone else with the same id as theirs, not as the room having it", async () => {
    handOver("general", [waiting("mine")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    socket().receive({ type: "message.created", message: { ...stored(waiting("mine")), creator: grace }, seq: 1 });
    expect(socket().closedWith).toBeUndefined();
  });

  it("asks the room about what went over a socket that closed, keeping what it never had as not sent", async () => {
    handOver("general", [sent("had"), sent("lost")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    expect(socket().sent).toEqual([{ type: "message.check", clientMessageIds: ["had", "lost"] }]);

    socket().receive({ type: "message.checked", stored: ["had"], missing: ["lost"] });
    expect(socket().closedWith).toBe(1000);
    expect(takeBack("general", ada)).toEqual([{ ...sent("lost"), failed: true }]);
  });

  it("doesn't ask about what's among the room's newest messages, which it has, and asks in batches the room accepts", async () => {
    const many = Array.from({ length: MAX_CHECKED_MESSAGES + 1 }, (_, i) => sent(`m${i}`));
    handOver("general", [sent("newest"), ...many]);
    await effectsRun();
    socket().open();
    socket().receive(welcome(ada, [stored(sent("newest"))]));
    expect(socket().sentOfType("message.check").map((frame) => (frame.clientMessageIds as string[]).length)).toEqual([MAX_CHECKED_MESSAGES, 1]);
    expect(socket().sent.flatMap((frame) => frame.clientMessageIds as string[])).not.toContain("newest");
  });

  it("asks again about what it sent over a socket that closed before the room confirmed it", async () => {
    handOver("general", [waiting("Written while away")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    socket().drop();
    wait(500);
    socket().open();
    socket().receive(welcome());
    expect(socket().sent).toEqual([{ type: "message.check", clientMessageIds: ["Written while away"] }]);
  });

  it("sends what's handed over to a socket the room has let in once the views going have handed over", async () => {
    handOver("general", [sent("in doubt")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    handOver("general", [waiting("Written while away")]);
    await effectsRun();
    expect(socket().sentOfType("message.create")).toEqual([{ type: "message.create", clientMessageId: "Written while away", body: "Written while away" }]);
  });

  it("sends what waited in the order it was written, though each view going hands over its own", async () => {
    const at = (second: number) => `2026-10-31T10:00:0${second}.000Z`;
    handOver("general", [waiting("A", { createdAt: at(1) }), waiting("C", { createdAt: at(3) })]);
    handOver("general", [waiting("B", { createdAt: at(2), parentId: "m1", alsoSent: true })]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    expect(socket().sentOfType("message.create").map((frame) => frame.body)).toEqual(["A", "B", "C"]);

    // And to a socket the room has let in already.
    handOver("general", [waiting("E", { createdAt: at(5) })]);
    handOver("general", [waiting("D", { createdAt: at(4), parentId: "m1" })]);
    await effectsRun();
    expect(socket().sentOfType("message.create").map((frame) => frame.body)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("marks what the room refuses as not sent, as a view does", async () => {
    handOver("general", [waiting("Doomed"), waiting("Fine")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    socket().receive({ type: "error", message: "Something went wrong", clientMessageId: "Doomed", failed: "message.create" });
    socket().receive({ type: "message.created", message: stored(waiting("Fine")), seq: 1 });
    expect(socket().closedWith).toBe(1000);
    expect(takeBack("general", ada)).toEqual([{ ...sent("Doomed"), failed: true }]);
  });
});

describe("Stop sending what was left unsent", () => {
  it(`shows what's waiting as not sent once it's been without the room ${OFFLINE_AFTER_MS / 1000} seconds, as a view does, and tries no more`, async () => {
    handOver("general", [waiting("Written while away"), sent("in doubt")]);
    await effectsRun();
    socket().drop();
    wait(OFFLINE_AFTER_MS);
    const sockets = FakeSocket.all.length;
    wait(60_000);
    expect(FakeSocket.all).toHaveLength(sockets);
    // What went, the view that takes it back asks about.
    expect(takeBack("general", ada)).toEqual([{ ...sent("Written while away"), failed: true }, sent("in doubt")]);
  });

  it("sends nothing as someone else, whom another tab has signed this browser in as", async () => {
    handOver("general", [waiting("Written while away")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome(grace));
    expect(socket().sent).toEqual([]);
    expect(socket().closedWith).toBe(1000);
    expect(takeBack("general", ada)).toEqual([{ ...sent("Written while away"), failed: true }]);
  });

  it.each([
    ["the room is gone for the person", CloseCode.NotFound],
    ["the person has lost access", CloseCode.Revoked],
  ])("stops once %s", async (_, code) => {
    handOver("general", [waiting("Written while away")]);
    await effectsRun();
    socket().drop(code);
    wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(takeBack("general", ada)).toEqual([{ ...sent("Written while away"), failed: true }]);
  });
});

describe("Take back what was left unsent", () => {
  it("hands the room's next view what was left in its timeline, and a thread's what was left in it, sending the rest", async () => {
    const message = waiting("In the room");
    const reply = waiting("In the thread", { parentId: "m1" });
    handOver("general", [message, reply]);
    await effectsRun();
    expect(takeBack("general", ada, "m1")).toEqual([reply]);
    expect(socket().closedWith).toBeUndefined();
    expect(takeBack("general", grace)).toEqual([]);
    expect(takeBack("general", ada)).toEqual([message]);
    expect(socket().closedWith).toBe(1000);
  });

  it("hands it back as it is by then: sent, waiting for the room to say it has it, or not sent", async () => {
    handOver("general", [waiting("Sent"), waiting("Refused")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    socket().receive({ type: "error", message: "Something went wrong", clientMessageId: "Refused", failed: "message.create" });
    expect(takeBack("general", ada)).toEqual([sent("Sent"), { ...sent("Refused"), failed: true }]);
  });

  it("hands one refused for what it says back with why, for the composer of the view taking it back to give back", async () => {
    handOver("general", [waiting("Fudge")]);
    await effectsRun();
    socket().open();
    socket().receive(welcome());
    socket().receive({ type: "error", message: "This community doesn't allow one of these words.", clientMessageId: "Fudge", failed: "message.create", rewrite: true });
    expect(takeBack("general", ada)).toEqual([{ ...sent("Fudge"), failed: true, rewrite: "This community doesn't allow one of these words." }]);
  });

  it("connects once every view going has handed over, and not at all when the view opening takes it all back", async () => {
    handOver("general", [waiting("In the room")]);
    handOver("general", [waiting("In the thread", { parentId: "m1" })]);
    expect(FakeSocket.all).toHaveLength(0);
    await effectsRun();
    expect(FakeSocket.all).toHaveLength(1);

    handOver("random", [waiting("Written while away", { roomId: "random" })]);
    expect(takeBack("random", ada)).toHaveLength(1);
    await effectsRun();
    expect(FakeSocket.all).toHaveLength(1);
  });
});

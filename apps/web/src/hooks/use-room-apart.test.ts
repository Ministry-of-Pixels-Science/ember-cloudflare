import { CloseCode, type ServerFrame, type User } from "@ember/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_AFTER_MS } from "@/lib/reconnecting-socket";
import { VISIBILITY_CHANGE_DELAY_MS } from "@/lib/visibility";
import { useRoomApart } from "./use-room-apart";

const ada: User = { id: "u1", name: "Ada" };
const grace: User = { id: "u2", name: "Grace" };

/** Stands in for the browser's WebSocket; tests play the room and the network. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number) {
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: code ?? 1005 }));
  }

  open() {
    act(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  receive(frame: ServerFrame) {
    act(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) })));
  }

  /** Closes as the network or the room does: 1006 when the connection drops. */
  drop(code = 1006) {
    act(() => {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.(new CloseEvent("close", { code }));
    });
  }

  sentOfType(type: string) {
    return this.sent.filter((frame) => frame.type === type);
  }
}

const socket = () => FakeSocket.all.at(-1)!;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const visibility = (state: DocumentVisibilityState) =>
  act(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
  });
const welcome = (you = ada): ServerFrame => ({ type: "welcome", you, messages: [], present: [you], hasMore: false, hasNewer: false, around: null, seq: 0 });
const refused = (about: Partial<Extract<ServerFrame, { type: "error" }>> = {}): ServerFrame => ({ type: "error", message: "You can't do that.", ...about });

/** Ada's socket to #general apart from its timeline, let in unless asked not to be, with what it has heard. */
function openApart({ connect = true } = {}) {
  const hook = renderHook(() => useRoomApart("general", ada.id));
  const heard: ServerFrame[] = [];
  const stop = hook.result.current.frames.listen((frame) => heard.push(frame));
  if (connect) {
    socket().open();
    socket().receive(welcome());
  }
  return { ...hook, heard, stop };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: back-off delays come out exact
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A socket that shows a part of a room apart from its timeline", () => {
  it("opens one of the room's sockets, whose address says that it's apart from the timeline, and whether the tab is shown", () => {
    openApart({ connect: false });
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/socket?visible=1&protocol=4&apart=1");

    cleanup();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    openApart({ connect: false });
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/socket?visible=0&protocol=4&apart=1");
  });

  it("is connecting until the room lets it in, and reconnecting from when its connection drops until the room lets it in again", () => {
    const { result } = openApart({ connect: false });
    expect(result.current.status).toBe("connecting");
    socket().open();
    expect(result.current.status).toBe("connecting");
    socket().receive(welcome());
    expect(result.current.status).toBe("open");

    socket().drop();
    expect(result.current.status).toBe("reconnecting");
    wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    socket().open();
    expect(result.current.status).toBe("reconnecting");
    socket().receive(welcome());
    expect(result.current.status).toBe("open");
  });

  it(`counts as offline once its connection has been down ${OFFLINE_AFTER_MS / 1000} seconds, until the room lets one in`, () => {
    const { result } = openApart();
    socket().drop();
    wait(OFFLINE_AFTER_MS - 1);
    expect(result.current.offline).toBe(false);
    wait(1);
    expect(result.current.offline).toBe(true);
    socket().open();
    expect(result.current.offline).toBe(true);
    socket().receive(welcome());
    expect(result.current.offline).toBe(false);
  });

  it("sends nothing until the room has let it in, and says whether a frame went", () => {
    const { result } = openApart({ connect: false });
    const open = { type: "thread.open", parentId: "m1" } as const;
    expect(result.current.frames.send(open)).toBe(false);
    socket().open();
    expect(result.current.frames.send(open)).toBe(false);
    socket().receive(welcome());
    expect(result.current.frames.send(open)).toBe(true);
    expect(socket().sent).toEqual([open]);

    socket().drop();
    expect(result.current.frames.send(open)).toBe(false);
  });

  it("hands whoever listens each frame from the room, the one that let it in among them, once it sends, until they stop listening", () => {
    const { result, heard, stop } = openApart({ connect: false });
    // What hears the welcome can send at once, as a thread asks to be opened.
    const sentAtWelcome: boolean[] = [];
    result.current.frames.listen((frame) => frame.type === "welcome" && sentAtWelcome.push(result.current.frames.send({ type: "thread.open", parentId: "m1" })));
    socket().open();
    socket().receive(welcome());
    expect(sentAtWelcome).toEqual([true]);
    const opened: ServerFrame = { type: "thread.opened", parentId: "m1", parent: null, messages: [], hasMore: false };
    socket().receive(opened);
    expect(heard).toEqual([welcome(), opened]);

    stop();
    socket().receive({ type: "presence.joined", user: grace });
    expect(heard).toHaveLength(2);
  });

  it("tells the room once the tab has been hidden for 5 seconds, and once it has been shown for 5 again", () => {
    openApart();
    visibility("hidden");
    wait(VISIBILITY_CHANGE_DELAY_MS - 1);
    expect(socket().sentOfType("presence.visible")).toEqual([]);
    wait(1);
    expect(socket().sentOfType("presence.visible")).toEqual([{ type: "presence.visible", visible: false }]);

    visibility("visible");
    // Showing the tab checks the connection, which the room answers.
    wait(200);
    socket().receive({ type: "pong" });
    wait(VISIBILITY_CHANGE_DELAY_MS - 200);
    expect(FakeSocket.all).toHaveLength(1);
    expect(socket().sentOfType("presence.visible")).toEqual([
      { type: "presence.visible", visible: false },
      { type: "presence.visible", visible: true },
    ]);
  });

  it("tells a room it was connecting to whether the tab is shown once the room lets the socket in, unless the socket's address said so", () => {
    openApart();
    socket().drop();
    visibility("hidden");
    // The room is connected to again before the tab has been hidden long enough to count.
    wait(VISIBILITY_CHANGE_DELAY_MS);
    expect(socket().url).toMatch(/visible=1&/);
    socket().open();
    socket().receive(welcome());
    expect(socket().sentOfType("presence.visible")).toEqual([{ type: "presence.visible", visible: false }]);

    socket().drop();
    wait(500);
    expect(socket().url).toMatch(/visible=0&/);
    socket().open();
    socket().receive(welcome());
    expect(socket().sentOfType("presence.visible")).toEqual([]);
  });

  it("keeps what the room last refused as its notice, until it's dismissed, but not what a thread shows for itself", () => {
    const { result, heard } = openApart();
    expect(result.current.notice).toBeNull();
    // A thread that couldn't be opened or paged, and replies that didn't go, are the thread's to show.
    const threads: ServerFrame[] = [
      refused({ failed: "thread.open" }),
      refused({ failed: "thread.before" }),
      refused({ clientMessageId: "c1" }),
      refused({ clientMessageIds: ["c1", "c2"] }),
    ];
    for (const frame of threads) socket().receive(frame);
    expect(result.current.notice).toBeNull();
    expect(heard.slice(1)).toEqual(threads);

    socket().receive(refused({ failed: "boost.delete" }));
    expect(result.current.notice).toBe("You can't do that.");
    socket().receive(refused({ message: "That message is gone." }));
    expect(result.current.notice).toBe("That message is gone.");
    act(() => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });

  it.each([
    ["the room is gone for its person, deleted or no longer theirs", CloseCode.NotFound],
    ["its person has lost their access", CloseCode.Revoked],
  ])("has nothing to connect to once %s", (_case, code) => {
    const { result } = openApart();
    socket().drop(code);
    expect(result.current.status).toBe("gone");
    wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(result.current.status).toBe("gone");
  });

  it("connects again after any other close, as when the room says to", () => {
    const { result } = openApart();
    socket().drop(CloseCode.Reconnect);
    expect(result.current.status).toBe("reconnecting");
    wait(500);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("lets nothing through a socket the room let in as someone else, and connects again, for the browser may be its person's again", () => {
    const { result, heard } = openApart({ connect: false });
    socket().open();
    socket().receive(welcome(grace));
    expect(heard).toEqual([]);
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.frames.send({ type: "thread.open", parentId: "m1" })).toBe(false);
    expect(socket().closedWith).toBe(1000);

    wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    socket().open();
    socket().receive(welcome());
    expect(result.current.status).toBe("open");
    expect(heard).toEqual([welcome()]);
  });

  it("closes its socket as it goes, and follows the tab no longer", () => {
    const { unmount } = openApart();
    const [only] = FakeSocket.all;
    unmount();
    expect(only!.closedWith).toBe(1000);
    visibility("hidden");
    // Nothing waits to tell a room how the tab has stayed.
    expect(vi.getTimerCount()).toBe(0);
    wait(VISIBILITY_CHANGE_DELAY_MS + 60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(only!.sent).toEqual([]);
  });
});

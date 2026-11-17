import { CloseCode, type DirectRoom, type Me, type Message, type Room, type ServerFrame, type User } from "@ember/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeBack } from "@/lib/outbox";
import { HuddleThread } from "./huddle-thread";

const ada: Me = { id: "u1", name: "Ada", administrator: false };
const grace: User = { id: "u2", name: "Grace" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
/** Ada's direct message with Grace. */
const direct: DirectRoom = { id: "direct-1", kind: "direct", members: [ada, grace], activeAt: "2026-11-17T09:00:00.000Z" };

const message = (text: string, overrides: Partial<Message> = {}): Message => ({
  id: text,
  clientMessageId: text,
  roomId: "general",
  creator: ada,
  body: `<p>${text}</p>`,
  plainText: text,
  mentions: [],
  createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z",
  editedAt: null,
  boosts: [],
  ...overrides,
});
/** The room's message of the huddle, which Ada started. */
const ofHuddle = message("A huddle started", { id: "h1", huddle: { startedAt: "2026-11-17T10:00:00.000Z" } });
const reply = (text: string) => message(text, { id: `r-${text}`, creator: grace, parentId: "h1", alsoSent: false });

/** Stands in for the browser's WebSocket: the thread's own socket to the room, which the test plays the room on. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  receive(frame: ServerFrame) {
    act(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) })));
  }

  /** The room lets the socket in, as Ada. */
  letIn() {
    act(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
    this.receive({ type: "welcome", you: ada, messages: [], present: [ada], hasMore: false, hasNewer: false, around: null, seq: 0 });
  }
}

const socket = () => FakeSocket.all.at(-1)!;

/** The thread of the huddle in `room`, whose message is h1, as Ada has it, with its socket let in. */
function showThread(room: Room = general) {
  const onClose = vi.fn();
  render(<HuddleThread room={room} me={ada} messageId="h1" autoFocus={false} onClose={onClose} />);
  socket().letIn();
  return { onClose, user: userEvent.setup() };
}

/** The room answers the thread's opening: with its message and `replies`, or with no message. */
const opened = (replies: Message[] = [], parent: Message | null = ofHuddle) => socket().receive({ type: "thread.opened", parentId: "h1", parent, messages: replies, hasMore: false });

const panel = () => screen.getByRole("complementary", { name: "Huddle thread" });
const shownTexts = () => within(panel()).queryAllByRole("article").map((article) => article.querySelector(".message-content")!.textContent);

class NoObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("IntersectionObserver", NoObserver);
  vi.stubGlobal("ResizeObserver", NoObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  // What a test leaves unsent goes with the test.
  takeBack("general", ada, "h1");
});

describe("A huddle's thread", () => {
  it("is headed Thread, with Close thread, which tells the huddle", async () => {
    const { onClose, user } = showThread();
    expect(within(panel()).getByRole("heading", { name: "Thread" })).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Close thread" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks the room for the thread of the huddle's message, on a socket of its own that's apart from the room's timeline", () => {
    showThread();
    expect(FakeSocket.all).toHaveLength(1);
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/socket?visible=1&protocol=4&apart=1");
    expect(socket().sent).toEqual([{ type: "thread.open", parentId: "h1" }]);
  });

  it("says what the thread is for where a thread has its message, by the room's name or as a direct message, and shows the replies under it", () => {
    showThread();
    // From the start, while the room has yet to send the thread.
    expect(within(panel()).getByText("Every huddle has a thread")).toBeInTheDocument();
    opened([reply("Here's the checklist"), reply("Docs are ready")]);
    const log = within(panel()).getByRole("log", { name: "Thread" });
    expect(within(log).getByText("Every huddle has a thread")).toBeInTheDocument();
    expect(within(log).getByText("Messages, files and links sent here reach everyone in the huddle, and stay as a thread in general once it ends.")).toBeInTheDocument();
    // The huddle's message is the room's to show, and isn't here.
    expect(shownTexts()).toEqual(["Here's the checklist", "Docs are ready"]);
    expect(within(log).queryByText("2 replies")).not.toBeInTheDocument();
  });

  it("says that the thread stays in the direct message, in one's huddle", () => {
    showThread(direct);
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/direct-1/socket?visible=1&protocol=4&apart=1");
    opened();
    expect(within(panel()).getByText("Messages, files and links sent here reach everyone in the huddle, and stay as a thread in this direct message once it ends.")).toBeInTheDocument();
  });

  it("shows a reply as the room tells of it, and sends what's written as a reply in the thread", async () => {
    const { user } = showThread();
    opened([reply("Here's the checklist")]);
    socket().receive({ type: "message.created", message: reply("Docs are ready"), seq: 3 });
    expect(shownTexts()).toEqual(["Here's the checklist", "Docs are ready"]);
    // What's said in the room isn't the thread's.
    socket().receive({ type: "message.created", message: message("Lunch?", { creator: grace }), seq: 4 });
    expect(shownTexts()).toEqual(["Here's the checklist", "Docs are ready"]);

    const box = await within(panel()).findByRole("textbox", { name: "Write a reply" });
    await user.type(box, "On my way{Enter}");
    expect(socket().sent.at(-1)).toEqual(expect.objectContaining({ type: "message.create", body: "<p>On my way</p>", parentId: "h1", alsoSend: false }));
    expect(shownTexts()).toEqual(["Here's the checklist", "Docs are ready", "On my way"]);
  });

  it("has the people @ lists show above the text being written, since the panel ends under its composer, where they'd be cut off", async () => {
    showThread();
    opened();
    expect(await within(panel()).findByRole("textbox", { name: "Write a reply" })).toHaveAttribute("data-mentions-above");
  });

  it("says that the huddle has no thread while the room has no message of it, with nothing to reply in, until the room writes one", async () => {
    showThread();
    opened([], null);
    expect(within(panel()).getByText("This huddle’s message isn’t in general, so it has no thread.")).toBeInTheDocument();
    expect(within(panel()).queryByText("Every huddle has a thread")).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("textbox", { name: "Write a reply" })).not.toBeInTheDocument();

    // A message that couldn't be written as the huddle started is written at the room's next check.
    socket().receive({ type: "message.created", message: ofHuddle, seq: 1 });
    expect(within(panel()).getByText("Every huddle has a thread")).toBeInTheDocument();
    expect(await within(panel()).findByRole("textbox", { name: "Write a reply" })).toBeInTheDocument();

    // And one that's deleted takes its thread with it.
    socket().receive({ type: "message.deleted", messageId: "h1", seq: 2 });
    expect(within(panel()).getByText("This huddle’s message isn’t in general, so it has no thread.")).toBeInTheDocument();
    expect(within(panel()).queryByRole("textbox", { name: "Write a reply" })).not.toBeInTheDocument();
  });

  it("names a direct message as the place a huddle's message isn't in", () => {
    showThread(direct);
    opened([], null);
    expect(within(panel()).getByText("This huddle’s message isn’t in this direct message, so it has no thread.")).toBeInTheDocument();
  });

  it("says what the room refused, which nothing else on its socket would show, until that's dismissed", async () => {
    const { user } = showThread();
    opened([reply("Here's the checklist")]);
    socket().receive({ type: "error", message: "Only the person who reacted can remove a reaction.", failed: "boost.delete" });
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Only the person who reacted can remove a reaction.");
    await user.click(within(panel()).getByRole("button", { name: "Dismiss" }));
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says that the room was deleted in place of the composer, once the room is gone for its person", () => {
    showThread();
    opened();
    act(() => socket().onclose?.(new CloseEvent("close", { code: CloseCode.NotFound })));
    expect(within(panel()).getByRole("alert")).toHaveTextContent("This room was deleted.");
    expect(within(panel()).queryByRole("textbox", { name: "Write a reply" })).not.toBeInTheDocument();
  });
});

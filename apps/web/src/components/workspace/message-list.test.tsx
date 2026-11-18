import type { Invitation, Me, Message } from "@ember/protocol";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { initialRoomState, type RoomState } from "@/lib/room-state";
import { MessageList } from "./message-list";

/**
 * jsdom has no layout, so tests say whether each end of the timeline is in view. Like the real
 * thing, an observer reports once when it starts observing, then on every change.
 */
class FakeIntersectionObserver {
  static inView = { top: false, bottom: false };
  static observers = new Set<FakeIntersectionObserver>();
  private end: "top" | "bottom" = "top";
  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe(target: Element) {
    // The timeline's top is the first thing in it, and its bottom the last.
    this.end = target.previousElementSibling ? "bottom" : "top";
    FakeIntersectionObserver.observers.add(this);
    this.report();
  }
  report() {
    this.callback([{ isIntersecting: FakeIntersectionObserver.inView[this.end] }]);
  }
  disconnect() {
    FakeIntersectionObserver.observers.delete(this);
  }
}

/** jsdom has no ResizeObserver either. Like the real thing, it reports when it starts observing and when the size changes. */
class FakeResizeObserver {
  static observers = new Set<FakeResizeObserver>();
  constructor(readonly callback: () => void) {}
  observe() {
    FakeResizeObserver.observers.add(this);
    this.callback();
  }
  disconnect() {
    FakeResizeObserver.observers.delete(this);
  }
}

const scrollIntoView = (end: "top" | "bottom") =>
  act(() => {
    FakeIntersectionObserver.inView[end] = true;
    FakeIntersectionObserver.observers.forEach((o) => o.report());
  });

/**
 * jsdom has no layout either, so tests lay the timeline out: its messages one after another, each 100px
 * tall unless `heights` says otherwise, in a log that shows 400px of them and scrolls only as far as they
 * go. A test that changes a height calls `resize`, as a message that grows after it's drawn makes the
 * browser report.
 */
function layOut(log: HTMLElement, heights: Record<string, number> = {}) {
  const rows = () => [...log.querySelectorAll<HTMLElement>("[data-row]")];
  const heightOf = (row: HTMLElement) => heights[row.dataset.messageId!] ?? 100;
  const total = (rows: HTMLElement[]) => rows.reduce((sum, row) => sum + heightOf(row), 0);
  const scrollHeight = () => Math.max(400, total(rows()));
  let scrollTop = 0;
  Object.defineProperties(log, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: scrollHeight },
    scrollTop: { configurable: true, get: () => scrollTop, set: (top: number) => (scrollTop = Math.min(Math.max(0, top), scrollHeight() - log.clientHeight)) },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === log) return DOMRect.fromRect({ width: 800, height: log.clientHeight });
    const above = rows().indexOf(this);
    if (above < 0) return DOMRect.fromRect();
    return DOMRect.fromRect({ y: total(rows().slice(0, above)) - scrollTop, width: 800, height: heightOf(this) });
  });
  const resize = () => act(() => FakeResizeObserver.observers.forEach((o) => o.callback()));
  resize();
  return { heights, resize };
}

/** Makes the log show `height` px of the timeline, as resizing it does, though the browser hasn't reported it yet. */
const setViewHeight = (log: HTMLElement, height: number) => Object.defineProperty(log, "clientHeight", { configurable: true, value: height });

const scrollTo = (log: HTMLElement, top: number) => {
  log.scrollTop = top;
  fireEvent.scroll(log);
};

const ada: Me = { id: "u1", name: "Ada", administrator: false };
const actions = { boost: vi.fn(), unboost: vi.fn(), edit: vi.fn(), remove: vi.fn(), click: vi.fn() };
const editors = { open: vi.fn(), close: vi.fn(), returnFocus: vi.fn(), attach: vi.fn(), reply: vi.fn() };

/** Messages from Ada named m`from` to m`to`. */
const messages = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message(`m${from + i}`));

/** A message from Ada, named by its id. */
const message = (id: string, createdAt = "2026-10-12T10:00:00.000Z"): Message => ({
  id,
  clientMessageId: id,
  roomId: "general",
  creator: ada,
  body: id,
  plainText: id,
  mentions: [],
  createdAt,
  updatedAt: createdAt,
  editedAt: null,
  boosts: [],
});

const list = (state: Partial<RoomState>, onLoadOlder: () => void = vi.fn(), invitation: Invitation | null = null, more: Partial<ComponentProps<typeof MessageList>> = {}) => (
  <MessageList
    roomName="general"
    invitation={invitation}
    onDismissInvitation={vi.fn()}
    state={{ ...initialRoomState, status: "open", ...state }}
    me={ada}
    actions={actions}
    editing={new Set()}
    editors={editors}
    onLoadOlder={onLoadOlder}
    onLoadNewer={vi.fn()}
    onJumpToNewest={vi.fn(() => true)}
    {...more}
  />
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T18:00:00"));
  FakeIntersectionObserver.inView = { top: false, bottom: false };
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The ids of the messages `records` put in the timeline, in the order they went in. */
const drawnBy = (records: MutationRecord[]) =>
  records.flatMap((record) => [...record.addedNodes].flatMap((node) => (node instanceof HTMLElement && node.dataset.messageId ? [node.dataset.messageId] : [])));

/** The ids of the messages put in the timeline since `observer` last looked, in the order they went in. */
const drawnSince = (observer: MutationObserver) => drawnBy(observer.takeRecords());

const ids = (from: number, to: number) => messages(from, to).map((m) => m.id);

describe("Open a room", () => {
  /** The timeline of a room that's opening, watched for the messages its first page puts in it. */
  function opening() {
    const view = render(list({ status: "connecting", messages: [] }));
    const observer = new MutationObserver(() => {});
    observer.observe(screen.getByRole("log"), { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    return { ...view, observer };
  }

  it("draws a room's first page newest first where those fill the view, then the rest above them", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1_000);
    const { rerender, observer } = opening();
    rerender(list({ messages: messages(1, 40), focus: { messageId: null } }));
    expect(drawnSince(observer)).toEqual([...ids(26, 40), ...ids(1, 25)]);
    expect([...screen.getByRole("log").querySelectorAll<HTMLElement>("[data-message-id]")].map((row) => row.dataset.messageId)).toEqual(ids(1, 40));
    expect(screen.getByRole("log")).not.toHaveAttribute("aria-busy");
  });

  it("draws a permalink's page whole, with its message in the middle", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1_000);
    const { rerender, observer } = opening();
    rerender(list({ messages: messages(1, 40), focus: { messageId: "m20" } }));
    expect(drawnSince(observer)).toEqual(ids(1, 40));
  });

  it("draws messages as they come once the timeline has shown some, however many come", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1_000);
    const { rerender, observer } = opening();
    rerender(list({ messages: messages(1, 3) }));
    expect(drawnSince(observer)).toEqual(ids(1, 3));
    rerender(list({ messages: messages(1, 20) }));
    expect(drawnSince(observer)).toEqual(ids(4, 20));
  });

  /**
   * Opens a room's first page in a view `viewHeight` px tall, where its newest messages are `height` px tall, as a
   * browser renders it: outside act(), which renders everything before it returns, and with laying the messages out
   * taking long enough that React's scheduler hands the main thread back after, as it does in a browser. Answers
   * the messages put in the timeline at each turn of the event loop, where a browser can paint.
   */
  async function drawnOpeningInBrowser(height: number, viewHeight: number) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => {
      const laidOut = performance.now() + 20;
      while (performance.now() < laidOut);
      return height;
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    onTestFinished(() => {
      act(() => root.unmount());
      container.remove();
    });
    root.render(list({ status: "connecting", messages: [] }));
    const log = await vi.waitFor(() => screen.getByRole("log"));
    setViewHeight(log, viewHeight);
    const turns: string[][] = [];
    const observer = new MutationObserver((records) => turns.push(drawnBy(records)));
    observer.observe(log, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    root.render(list({ messages: messages(1, 40), focus: { messageId: null } }));
    await vi.waitFor(() => expect(log).not.toHaveAttribute("aria-busy"), { timeout: 5_000 });
    return turns.filter((drawn) => drawn.length > 0);
  }

  it("lets the browser paint a room's newest messages before it draws the rest", async () => {
    expect(await drawnOpeningInBrowser(1_000, 400)).toEqual([ids(26, 40), ids(1, 25)]);
  });

  it("draws a room's whole first page before the browser paints where its newest messages don't fill the view", async () => {
    expect(await drawnOpeningInBrowser(300, 800)).toEqual([[...ids(26, 40), ...ids(1, 25)]]);
  });
});

describe("Empty room", () => {
  it("welcomes people to a room with no messages yet", () => {
    render(list({ messages: [] }));
    expect(screen.getByRole("heading", { name: "Welcome to #general" })).toBeInTheDocument();
  });

  it("doesn't claim the room is empty before it has loaded", () => {
    render(list({ status: "connecting", messages: [] }));
    expect(screen.queryByRole("heading", { name: "Welcome to #general" })).not.toBeInTheDocument();
  });

  it("loads earlier messages instead when every message it had was deleted", () => {
    FakeIntersectionObserver.inView.top = true;
    const onLoadOlder = vi.fn();
    render(list({ messages: [], hasMore: true }, onLoadOlder));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Welcome to #general" })).not.toBeInTheDocument();
  });
});

describe("Attach files", () => {
  it("hands the files dropped anywhere on the room's messages to the composer, as a copy", () => {
    const onDropFiles = vi.fn();
    const { container } = render(list({ messages: messages(1, 3) }, vi.fn(), null, { onDropFiles }));
    const messageArea = container.firstElementChild as HTMLElement;
    const file = new File(["a"], "a.txt");
    const dataTransfer = { files: [file], dropEffect: "none" };
    // Each is cancelled, so the browser doesn't open the file in place of the page.
    expect(fireEvent.dragEnter(messageArea, { dataTransfer })).toBe(false);
    expect(fireEvent.dragOver(messageArea, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(fireEvent.drop(within(messageArea).getByText("m2"), { dataTransfer })).toBe(false);
    expect(onDropFiles).toHaveBeenCalledExactlyOnceWith([file]);
  });
});

describe("Group DMs and DM names", () => {
  it("names a DM's messages and its beginning for the others in it", () => {
    render(
      <MessageList roomName="Grace and Linus" direct invitation={null} onDismissInvitation={vi.fn()} state={{ ...initialRoomState, status: "open", messages: [] }} me={ada} actions={actions} editing={new Set()} editors={editors} onLoadOlder={vi.fn()} onLoadNewer={vi.fn()} onJumpToNewest={vi.fn()} />,
    );
    expect(screen.getByRole("log", { name: "Messages with Grace and Linus" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Grace and Linus" })).toBeInTheDocument();
    expect(screen.getByText("This is the very beginning of your direct messages.")).toBeInTheDocument();
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });
});

describe("Catch up after a reconnect", () => {
  it("marks the timeline busy until the room lets the socket in, which brings its messages afresh", () => {
    const { rerender } = render(list({ status: "connecting", messages: [] }));
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
    rerender(list({ messages: [message("m1")] }));
    expect(screen.getByRole("log")).not.toHaveAttribute("aria-busy");
    rerender(list({ status: "reconnecting", messages: [message("m1")] }));
    expect(screen.getByRole("log")).toHaveAttribute("aria-busy", "true");
    rerender(list({ status: "gone", messages: [message("m1")] }));
    expect(screen.getByRole("log")).not.toHaveAttribute("aria-busy");
  });
});

describe("Take back a reaction", () => {
  it("brings back a reaction shown as going once the room refuses to delete one, or lets the page in again", async () => {
    const boosted: Message = { ...message("m1"), boosts: [{ id: "b1", messageId: "m1", booster: ada, content: "👍", createdAt: "" }] };
    const pill = () => within(screen.getByRole("list", { name: "Reactions" })).getByRole("listitem");
    const remove = async () => {
      actions.unboost.mockReturnValueOnce(true);
      await userEvent.click(within(pill()).getByRole("button", { name: "Delete this boost" }));
    };
    const { rerender } = render(list({ messages: [boosted], connections: 1 }));
    await userEvent.click(screen.getByRole("button", { name: "👍" }));
    await remove();
    expect(pill()).toHaveClass("animate-scale-fade-out");
    rerender(list({ messages: [boosted], connections: 1, refusedUnboosts: 1 }));
    expect(pill()).not.toHaveClass("animate-scale-fade-out");

    await remove();
    expect(pill()).toHaveClass("animate-scale-fade-out");
    rerender(list({ messages: [boosted], connections: 2, refusedUnboosts: 1 }));
    expect(pill()).not.toHaveClass("animate-scale-fade-out");
  });
});

describe("Welcome and invite card", () => {
  const invitation = { roomId: "general", joinCode: "aB3d-Ef5h-iJ7k" };
  const card = () => screen.queryByRole("heading", { name: "Welcome to Ember" });

  it("welcomes people to the workspace's first room with the card instead, while it's new", () => {
    render(list({ messages: [], paged: false }, vi.fn(), invitation));
    expect(card()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome to #general" })).not.toBeInTheDocument();
  });

  it("puts the card above the room's messages, in the timeline", () => {
    render(list({ messages: [message("hello")], paged: false }, vi.fn(), invitation));
    const log = screen.getByRole("log");
    expect(log).toContainElement(card());
    expect(card()!.compareDocumentPosition(screen.getByRole("article")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves it out where the room had more than a page when it opened, or hasn't answered yet", () => {
    const { rerender } = render(list({ messages: [message("hello")], paged: true }, vi.fn(), invitation));
    expect(card()).not.toBeInTheDocument();
    rerender(list({ status: "connecting", messages: [], paged: null }, vi.fn(), invitation));
    expect(card()).not.toBeInTheDocument();
  });

  it("shows no card in other rooms", () => {
    render(list({ messages: [], paged: false }));
    expect(card()).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome to #general" })).toBeInTheDocument();
  });
});

describe("Sign in with Memberful", () => {
  it("shows no welcome card while Memberful is members only, since its join link is off", () => {
    const account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: true, memberfulSignIn: true, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };
    render(<AccountContext value={account}>{list({ messages: [], paged: false }, vi.fn(), { roomId: "general", joinCode: "aB3d-Ef5h-iJ7k" })}</AccountContext>);
    expect(screen.queryByRole("heading", { name: "Welcome to Ember" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome to #general" })).toBeInTheDocument();
  });
});

describe("Ways to join", () => {
  it("shows no welcome card while the join link is off, but shows it again once it's on", () => {
    const account = { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: false, openSignUp: true, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true };
    const welcome = (joinLink: boolean) => <AccountContext value={{ ...account, joinLink }}>{list({ messages: [], paged: false }, vi.fn(), { roomId: "general", joinCode: "aB3d-Ef5h-iJ7k" })}</AccountContext>;
    const { rerender } = render(welcome(false));
    expect(screen.queryByRole("heading", { name: "Welcome to Ember" })).not.toBeInTheDocument();
    rerender(welcome(true));
    expect(screen.getByRole("heading", { name: "Welcome to Ember" })).toBeInTheDocument();
  });
});

describe("Welcome someone who joins", () => {
  const grace = { id: "u2", name: "Grace" };
  const joined = { user: grace, at: "2026-10-12T09:30:00" };
  /** Ada's DM with Grace, started as Grace joined, with `messages`, as far back as the room has said it goes. */
  const withGrace = (messages: Message[], state: Partial<RoomState> = {}) => list({ messages, paged: false, ...state }, vi.fn(), null, { direct: true, roomName: "Grace", joined });
  const days = () => screen.getAllByRole("heading", { level: 2 }).flatMap((heading) => (heading.querySelector("time") ? [heading.textContent] : []));

  it("opens a DM started as someone joined with their having joined the workspace, under the day they did", () => {
    render(withGrace([]));
    expect(screen.getByText("This is the very beginning of your direct messages.")).toBeInTheDocument();
    const line = screen.getByText("joined Ember");
    expect(line).toHaveClass("text-message-muted");
    const said = line.closest("article")!;
    expect(within(said).getByRole("heading", { level: 3 })).toHaveTextContent("Grace");
    expect(said.querySelector("h3 time")).toHaveAttribute("datetime", joined.at);
    expect(days()).toEqual(["October 12, 2026"]);
  });

  it("dates the day once when the first message came on it, and the next day the first came on", () => {
    const { rerender } = render(withGrace([message("m1", "2026-10-12T10:00:00")]));
    expect(days()).toEqual(["October 12, 2026"]);
    expect(screen.getByText("joined Ember").closest("[data-row]")!.nextElementSibling).toHaveAttribute("data-message-id", "m1");
    rerender(withGrace([message("m1", "2026-10-13T10:00:00")]));
    expect(days()).toEqual(["October 12, 2026", "October 13, 2026"]);
  });

  it("waits for the room to say its timeline reaches back that far", () => {
    const { rerender } = render(withGrace([], { status: "connecting", paged: null }));
    expect(screen.queryByText("joined Ember")).not.toBeInTheDocument();
    rerender(withGrace(messages(1, 3), { hasMore: true }));
    expect(screen.queryByText("joined Ember")).not.toBeInTheDocument();
  });
});

describe("Day separators", () => {
  it("heads each day with its date, and the date and time of its first message on hover", () => {
    render(list({ messages: [message("Saturday", "2026-10-10T09:00:00"), message("Sunday", "2026-10-11T09:00:00"), message("Later", "2026-10-11T15:04:00")] }));
    const days = screen.getAllByRole("heading", { level: 2 });
    expect(days.map((day) => day.textContent)).toEqual(["October 10, 2026", "October 11, 2026"]);
    expect(days[1]!.querySelector("time")).toHaveAttribute("title", "10/11/26, 9:00 AM");
  });
});

describe("New line", () => {
  const grace = { id: "u2", name: "Grace" };
  /** A message from Grace, named by its id. */
  const from = (id: string, createdAt: string): Message => ({ ...message(id, createdAt), creator: grace });
  const timeline = [message("Earlier", "2026-10-12T09:00:00.000Z"), from("Before", "2026-10-12T09:30:00.000Z"), message("Mine", "2026-10-12T10:00:00.000Z"), from("First new", "2026-10-12T10:05:00.000Z"), from("Second new", "2026-10-12T10:06:00.000Z")];
  const newLine = () => screen.queryByRole("separator", { name: "New messages" });
  /** The id of the message the New line is over. */
  const newLineOver = () => newLine()?.closest("[data-message-id]")?.getAttribute("data-message-id");

  it("draws New over the first message someone else wrote since the room was marked unread", () => {
    render(list({ messages: timeline }, vi.fn(), null, { newSince: "2026-10-12T10:00:00.000Z" }));
    expect(screen.getAllByRole("separator", { name: "New messages" })).toHaveLength(1);
    expect(newLineOver()).toBe("First new");
    expect(newLine()).toHaveTextContent("New");
  });

  it("draws none in a room that wasn't marked unread, or for only the reader's own messages since", () => {
    const { rerender } = render(list({ messages: timeline }));
    expect(newLine()).not.toBeInTheDocument();
    rerender(list({ messages: timeline.slice(0, 3) }, vi.fn(), null, { newSince: "2026-10-12T10:00:00.000Z" }));
    expect(newLine()).not.toBeInTheDocument();
  });

  it("keeps the line where it was as more messages come", () => {
    const { rerender } = render(list({ messages: timeline }, vi.fn(), null, { newSince: "2026-10-12T10:00:00.000Z" }));
    rerender(list({ messages: [...timeline, from("Third new", "2026-10-12T10:07:00.000Z")] }, vi.fn(), null, { newSince: "2026-10-12T10:00:00.000Z" }));
    expect(newLineOver()).toBe("First new");
  });

  it("draws none over the first message loaded when older new ones may not be loaded yet", () => {
    const { rerender } = render(list({ messages: timeline.slice(3), hasMore: true }, vi.fn(), null, { newSince: "2026-10-12T10:00:00.000Z" }));
    expect(newLine()).not.toBeInTheDocument();
    rerender(list({ messages: timeline.slice(3), hasMore: false }, vi.fn(), null, { newSince: "2026-10-12T10:00:00.000Z" }));
    expect(newLineOver()).toBe("First new");
  });

  it("draws none when the first message loaded is the reader's own, sent since, and older ones may not be loaded yet", () => {
    const { rerender } = render(list({ messages: timeline.slice(2), hasMore: true }, vi.fn(), null, { newSince: "2026-10-12T09:45:00.000Z" }));
    expect(newLine()).not.toBeInTheDocument();
    rerender(list({ messages: timeline.slice(2), hasMore: false }, vi.fn(), null, { newSince: "2026-10-12T09:45:00.000Z" }));
    expect(newLineOver()).toBe("First new");
  });
});

describe("Scroll back through history", () => {
  it("loads earlier messages when the top of the timeline comes into view", () => {
    const onLoadOlder = vi.fn();
    render(list({ messages: [message("m2")], hasMore: true }, onLoadOlder));
    expect(onLoadOlder).not.toHaveBeenCalled();
    scrollIntoView("top");
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("goes by the browser's last look at each end when it tells of more than one at once", () => {
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();
    render(list({ messages: messages(1, 2), hasMore: true, hasNewer: true }, onLoadOlder, null, { onLoadNewer }));
    const [older, newer] = FakeIntersectionObserver.observers;
    // The top was out of view, then the reader scrolled to it, before the browser told of either.
    act(() => older!.callback([{ isIntersecting: false }, { isIntersecting: true }]));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    // And the bottom came into view, then went out of it.
    act(() => newer!.callback([{ isIntersecting: true }, { isIntersecting: false }]));
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it("keeps loading while a tall window still shows the top, but not after a failed page", () => {
    FakeIntersectionObserver.inView.top = true;
    const onLoadOlder = vi.fn();
    const messages = [message("m3")];
    const { rerender } = render(list({ messages, hasMore: true }, onLoadOlder));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    rerender(list({ messages, hasMore: true, loadingOlder: true }, onLoadOlder));
    // The page failed: nothing changed, so it doesn't ask again on its own.
    rerender(list({ messages, hasMore: true }, onLoadOlder));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // A page arrived and the top is still in view, so it asks for the next one.
    rerender(list({ messages: [message("m2"), ...messages], hasMore: true }, onLoadOlder));
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("loads nothing for what the browser saw of the timeline before it changed", () => {
    // The browser looks while the room is still connecting, at the top of an empty timeline.
    FakeIntersectionObserver.inView.top = true;
    const onLoadOlder = vi.fn();
    const { rerender } = render(list({ status: "connecting", messages: [] }, onLoadOlder));
    const [sawEmpty] = FakeIntersectionObserver.observers;

    // The room's newest page comes before the browser has said what it saw, which the timeline shows at its end.
    FakeIntersectionObserver.inView.top = false;
    rerender(list({ messages: messages(1, 40), hasMore: true }, onLoadOlder));
    act(() => sawEmpty!.callback([{ isIntersecting: true }]));
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("says when it's loading earlier messages, and doesn't ask again meanwhile", () => {
    const onLoadOlder = vi.fn();
    render(list({ messages: [message("m2")], hasMore: true, loadingOlder: true }, onLoadOlder));
    expect(screen.getByText("Loading earlier messages…")).toBeInTheDocument();
    scrollIntoView("top");
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("keeps a reader's place as earlier messages come in above them", () => {
    const { rerender } = render(list({ messages: messages(5, 12), hasMore: true }));
    const log = screen.getByRole("log");
    const { resize } = layOut(log);
    scrollTo(log, 50);

    // The two that came are 200px tall, so the reader moves down as far and sees what they saw.
    rerender(list({ messages: messages(3, 12), hasMore: true }));
    expect(log.scrollTop).toBe(250);
    // The browser's own scroll anchoring may have moved them already, which changes nothing.
    resize();
    expect(log.scrollTop).toBe(250);
  });

  it("keeps a reader's place as messages above them go, deleted or cut from the start of a long timeline", () => {
    // Reading older history, so pages come at the end and the oldest messages are cut.
    const { rerender } = render(list({ messages: messages(1, 10), hasNewer: true }));
    const log = screen.getByRole("log");
    layOut(log);
    scrollTo(log, 550);

    rerender(list({ messages: messages(2, 10), hasNewer: true }));
    expect(log.scrollTop).toBe(450);
    rerender(list({ messages: messages(4, 12), hasNewer: true }));
    expect(log.scrollTop).toBe(250);
  });

  it("loads later messages when the bottom comes into view while the timeline holds older history", () => {
    const onLoadNewer = vi.fn();
    const more = { onLoadNewer };
    const { rerender } = render(list({ messages: messages(1, 2), hasNewer: true }, vi.fn(), null, more));
    expect(onLoadNewer).not.toHaveBeenCalled();
    scrollIntoView("bottom");
    expect(onLoadNewer).toHaveBeenCalledTimes(1);

    // Not while they're on their way, nor once it holds the newest.
    rerender(list({ messages: messages(1, 2), hasNewer: true, loadingNewer: true }, vi.fn(), null, more));
    rerender(list({ messages: messages(1, 3), hasNewer: true, loadingNewer: true }, vi.fn(), null, more));
    rerender(list({ messages: messages(1, 4) }, vi.fn(), null, more));
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it("stops once history runs out", () => {
    FakeIntersectionObserver.inView.top = true;
    const onLoadOlder = vi.fn();
    render(list({ messages: [message("m1")], hasMore: false }, onLoadOlder));
    scrollIntoView("top");
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});

describe("Stay at the newest message", () => {
  const jump = () => screen.queryByRole("button", { name: "Jump to newest message" });

  it("stays at the newest message as new ones come while you're near it", () => {
    const { rerender } = render(list({ messages: messages(1, 6) }));
    const log = screen.getByRole("log", { name: "Messages in general" });
    layOut(log);
    expect(log.scrollTop).toBe(200);

    rerender(list({ messages: messages(1, 7), arrivals: 1 }));
    expect(log.scrollTop).toBe(300);
    // Within 100px of the end is at it.
    scrollTo(log, 220);
    rerender(list({ messages: messages(1, 8), arrivals: 2 }));
    expect(log.scrollTop).toBe(400);
    expect(jump()).not.toBeInTheDocument();
  });

  it("offers Jump to newest message when new ones come while you're further up, rather than on scrolling up", async () => {
    const onJumpToNewest = vi.fn(() => true);
    const more = { onJumpToNewest };
    const { rerender } = render(list({ messages: messages(1, 6) }, vi.fn(), null, more));
    const log = screen.getByRole("log");
    layOut(log);
    scrollTo(log, 0);
    expect(jump()).not.toBeInTheDocument();

    rerender(list({ messages: messages(1, 7), arrivals: 1 }, vi.fn(), null, more));
    expect(log.scrollTop).toBe(0);
    await userEvent.click(jump()!);
    expect(onJumpToNewest).toHaveBeenCalledTimes(1);
    expect(jump()).not.toBeInTheDocument();

    // It goes once the reader is back at the end, too.
    rerender(list({ messages: messages(1, 8), arrivals: 2 }, vi.fn(), null, more));
    expect(jump()).toBeInTheDocument();
    scrollTo(log, 400);
    expect(jump()).not.toBeInTheDocument();
  });

  it("offers it whenever new ones come while the timeline holds older history, which they wait beyond", () => {
    const { rerender } = render(list({ messages: messages(1, 6), hasNewer: true }));
    const log = screen.getByRole("log");
    layOut(log);
    scrollTo(log, 200);
    rerender(list({ messages: messages(1, 6), hasNewer: true, arrivals: 1 }));
    expect(jump()).toBeInTheDocument();
  });

  it("keeps it to try again when it can't go yet, as while the room is away and the newest aren't loaded", async () => {
    const onJumpToNewest = vi.fn(() => false);
    const more = { onJumpToNewest };
    const { rerender } = render(list({ messages: messages(1, 6), hasNewer: true }, vi.fn(), null, more));
    const log = screen.getByRole("log");
    layOut(log);
    scrollTo(log, 200);
    rerender(list({ messages: messages(1, 6), hasNewer: true, arrivals: 1 }, vi.fn(), null, more));
    await userEvent.click(jump()!);
    expect(jump()).toBeInTheDocument();

    onJumpToNewest.mockReturnValue(true);
    await userEvent.click(jump()!);
    expect(onJumpToNewest).toHaveBeenCalledTimes(2);
    expect(jump()).not.toBeInTheDocument();
  });

  it("follows new ones again once a short last page of later messages leaves the reader at the end", () => {
    const { rerender } = render(list({ messages: messages(1, 6), hasNewer: true }));
    const log = screen.getByRole("log");
    layOut(log, { m7: 40 });
    scrollTo(log, 200);
    rerender(list({ messages: messages(1, 6), hasNewer: true, arrivals: 1 }));
    expect(jump()).toBeInTheDocument();

    // The last page adds 40px below the view, which doesn't scroll the reader, but leaves them at the end.
    rerender(list({ messages: messages(1, 7), arrivals: 1 }));
    expect(log.scrollTop).toBe(200);
    expect(jump()).not.toBeInTheDocument();
    rerender(list({ messages: messages(1, 8), arrivals: 2 }));
    expect(log.scrollTop).toBe(340);
    expect(jump()).not.toBeInTheDocument();
  });

  it("keeps what's in view where it is as a message above its end grows, as an edit or a reaction does", () => {
    const { rerender } = render(list({ messages: messages(1, 8) }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    scrollTo(log, 200);

    // m5 is in view, above m6, the last message that starts in view, whose bottom stays where it was.
    heights.m5 = 150;
    resize();
    expect(log.scrollTop).toBe(250);
    // m8 is below it, so nothing moves.
    heights.m8 = 300;
    resize();
    expect(log.scrollTop).toBe(250);
    // Nor as a message changes in the room, keeping the bottom for an edit above the fold.
    heights.m2 = 200;
    rerender(list({ messages: messages(1, 8) }));
    expect(log.scrollTop).toBe(350);
  });

  it("keeps the reader where they scroll as the timeline resizes, though the scroll comes before the resize is reported", () => {
    const { rerender } = render(list({ messages: messages(1, 8) }));
    const log = screen.getByRole("log");
    const { resize } = layOut(log);
    expect(log.scrollTop).toBe(400);
    // The composer is 6px shorter for a moment as its editor loads, so the timeline is 6px taller.
    setViewHeight(log, 406);
    scrollTo(log, 0);
    resize();
    expect(log.scrollTop).toBe(0);
    rerender(list({ messages: messages(1, 9), arrivals: 1 }));
    expect(log.scrollTop).toBe(0);
    expect(jump()).toBeInTheDocument();
  });

  it("keeps the place of a reader away from the newest message who scrolls to where the end was before the timeline shrank", () => {
    const { rerender } = render(list({ messages: messages(1, 8) }));
    const log = screen.getByRole("log");
    const { resize } = layOut(log);
    scrollTo(log, 0);
    // The timeline is 300px shorter, as when the keyboard opens, and before that's reported, the reader
    // scrolls to where its end was, which is 300px from it now.
    setViewHeight(log, 100);
    scrollTo(log, 400);
    resize();
    expect(log.scrollTop).toBe(400);
    rerender(list({ messages: messages(1, 9), arrivals: 1 }));
    expect(log.scrollTop).toBe(400);
    expect(jump()).toBeInTheDocument();
  });

  it("stays at the newest message when the scroll a resize made comes once the timeline has resized again", () => {
    const { rerender } = render(list({ messages: messages(1, 8) }));
    const log = screen.getByRole("log");
    const { resize } = layOut(log);
    // The timeline grows, as when the keyboard closes, which keeps the end in view by scrolling it.
    setViewHeight(log, 520);
    log.scrollTop = 280;
    resize();
    // It shrinks, as when the keyboard opens, before the scroll that the growing made arrives.
    setViewHeight(log, 20);
    fireEvent.scroll(log);
    resize();
    expect(log.scrollTop).toBe(780);
    rerender(list({ messages: messages(1, 9), arrivals: 1 }));
    expect(log.scrollTop).toBe(880);
    expect(jump()).not.toBeInTheDocument();
  });

  it("stays at the newest message as it grows, though the browser scrolls the timeline on its own before that's reported", () => {
    const { rerender } = render(list({ messages: messages(1, 8) }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    expect(log.scrollTop).toBe(400);
    // m8 grows 300px, as a message does when its file's text loads, and before that's reported, the browser scrolls
    // the timeline 50px, as Chrome's scroll anchoring can, which leaves its end 250px below the view.
    heights.m8 = 400;
    scrollTo(log, 450);
    resize();
    expect(log.scrollTop).toBe(700);
    rerender(list({ messages: messages(1, 9), arrivals: 1 }));
    expect(log.scrollTop).toBe(800);
    expect(jump()).not.toBeInTheDocument();
  });

  it("goes to the end as you send or jump there", () => {
    const { rerender } = render(list({ messages: messages(1, 8) }));
    const log = screen.getByRole("log");
    layOut(log);
    scrollTo(log, 0);
    rerender(list({ messages: messages(1, 8), focus: { messageId: null } }));
    expect(log.scrollTop).toBe(400);
  });
});

describe("Link to a message", () => {
  it("centres the message a permalink goes to and outlines it, each time it's gone to", () => {
    // jsdom can't animate.
    const animate = vi.fn();
    Element.prototype.animate = animate;
    onTestFinished(() => void delete (Element.prototype as Partial<Element>).animate);
    const { rerender } = render(list({ messages: messages(1, 10) }));
    const log = screen.getByRole("log");
    layOut(log);
    const body = log.querySelector('[data-message-id="m5"] [data-body-content]');

    // m5 is 400px down and 100px tall, so it's in the middle of the 400px view at 250px.
    let focus = { messageId: "m5" };
    rerender(list({ messages: messages(1, 10), focus }));
    expect(log.scrollTop).toBe(250);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(body);

    scrollTo(log, 0);
    focus = { messageId: "m5" };
    rerender(list({ messages: messages(1, 10), focus }));
    expect(log.scrollTop).toBe(250);
    expect(animate).toHaveBeenCalledTimes(2);

    // Away from the end, the reader stays as new messages come, and can jump to them.
    rerender(list({ messages: messages(1, 11), focus, arrivals: 1 }));
    expect(log.scrollTop).toBe(250);
    expect(screen.getByRole("button", { name: "Jump to newest message" })).toBeInTheDocument();
  });
});

describe("Edit a message", () => {
  it("leaves the reader where they are as an editor opens at the end, which following the end would push up and stop scrolling to the middle", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    expect(log.scrollTop).toBe(400);
    // Any scroll set stops the editor's own, smooth one.
    const scrolled = vi.spyOn(log, "scrollTop", "set");

    // m5, at the top of the view, opens an editor that's 150px taller than it once Lexxy has filled it in.
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m5"]) }));
    heights.m5 = 250;
    resize();
    expect(log.scrollTop).toBe(400);
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("keeps an editor that opens away from the end where its message was, the first message's too", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);

    // m3 is at the top of the view, above m6, the last message that starts in view.
    scrollTo(log, 200);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m3"]) }));
    heights.m3 = 250;
    resize();
    expect(log.scrollTop).toBe(200);

    scrollTo(log, 0);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m1", "m3"]) }));
    heights.m1 = 250;
    resize();
    expect(log.scrollTop).toBe(0);
  });

  it("leaves an editor where it is as it grows again once the timeline has scrolled, which keeping the place of a message below it would push up", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    scrollTo(log, 200);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m3"]) }));
    heights.m3 = 150;
    resize();

    // The editor's scroll to the middle of the timeline is under way as it grows again, as Lexxy fills it in.
    scrollTo(log, 150);
    heights.m3 = 250;
    resize();
    expect(log.scrollTop).toBe(150);
  });

  it("leaves an editor that opens at the end where it is as its link's preview loads, though the browser has scrolled back to the end", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);

    // m6's editor comes out shorter than the message, so the browser scrolls the timeline back to its end.
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m6"]) }));
    heights.m6 = 92;
    resize();
    scrollTo(log, 392);
    heights.m6 = 282;
    resize();
    expect(log.scrollTop).toBe(392);
  });

  it("leaves the scroll Lexxy makes to bring an editor's caret into view, though its event hasn't come", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);

    // The newest message's editor goes on below the view, so Lexxy scrolls the timeline to show its caret.
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m8"]) }));
    heights.m8 = 250;
    log.scrollTop = 446;
    resize();
    expect(log.scrollTop).toBe(446);
  });

  it("doesn't set the scroll as messages change while an editor is open away from the end, which would stop its scroll to the middle", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    scrollTo(log, 200);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m3"]) }));
    heights.m3 = 250;
    resize();
    const scrolled = vi.spyOn(log, "scrollTop", "set");

    // Someone reacts to a message as the editor scrolls itself to the middle of the timeline.
    rerender(list({ messages: messages(1, 8) }, vi.fn(), null, { editing: new Set(["m3"]) }));
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("still brings a reader near the end to new messages while an editor is open", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m8"]) }));
    heights.m8 = 150;
    resize();
    expect(log.scrollTop).toBe(400);

    rerender(list({ messages: messages(1, 9), arrivals: 1 }, vi.fn(), null, { editing: new Set(["m8"]) }));
    expect(log.scrollTop).toBe(550);
    expect(screen.queryByRole("button", { name: "Jump to newest message" })).not.toBeInTheDocument();
  });

  it("keeps a reader at the end there as the timeline itself gets shorter while an editor is open, as a phone's keyboard makes it", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m8"]) }));
    heights.m8 = 150;
    resize();
    expect(log.scrollTop).toBe(400);

    // The keyboard takes 300px of the timeline's 400.
    setViewHeight(log, 100);
    resize();
    expect(log.scrollTop).toBe(750);
    rerender(list({ messages: messages(1, 9), arrivals: 1 }, vi.fn(), null, { editing: new Set(["m8"]) }));
    expect(log.scrollTop).toBe(850);
    expect(screen.queryByRole("button", { name: "Jump to newest message" })).not.toBeInTheDocument();
  });

  it("keeps the place of a reader away from the end as the timeline itself gets shorter while an editor is open", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    scrollTo(log, 200);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m3"]) }));
    heights.m3 = 250;
    resize();
    expect(log.scrollTop).toBe(200);

    // m5, the last message that starts in view, keeps its bottom 50px below the view's as the view loses 300px.
    setViewHeight(log, 100);
    resize();
    expect(log.scrollTop).toBe(500);
  });

  it("keeps the reader's place again once the editor has closed", () => {
    const shown = messages(1, 8);
    const { rerender } = render(list({ messages: shown }));
    const log = screen.getByRole("log");
    const { heights, resize } = layOut(log);
    scrollTo(log, 200);
    rerender(list({ messages: shown }, vi.fn(), null, { editing: new Set(["m3"]) }));
    heights.m3 = 250;
    resize();
    expect(log.scrollTop).toBe(200);

    // m5, the last message that starts in view, stays where it was as the message goes back to its size.
    rerender(list({ messages: shown }));
    heights.m3 = 100;
    resize();
    expect(log.scrollTop).toBe(50);
  });
});

describe("Threads", () => {
  const thread = { header: <p>Who has the keys?</p>, place: { roomName: "general", direct: false } };

  it("shows a thread's message over its replies, with no day's heading between them, and none of a room's welcome", () => {
    render(list({ messages: [message("Saturday", "2026-10-10T09:00:00"), message("Sunday", "2026-10-11T09:00:00")] }, vi.fn(), null, { thread }));
    const log = screen.getByRole("log", { name: "Thread" });
    expect(log).toHaveTextContent(/^Who has the keys\?/);
    expect(within(log).getAllByRole("heading", { level: 2 }).map((day) => day.textContent)).toEqual(["October 11, 2026"]);
    cleanup();

    render(list({ messages: [] }, vi.fn(), null, { thread }));
    expect(screen.queryByRole("heading", { name: "Welcome to #general" })).not.toBeInTheDocument();
  });

  it("marks the message whose thread is open beside the room", () => {
    render(list({ messages: messages(1, 2) }, vi.fn(), null, { openThread: "m2" }));
    expect(screen.getAllByRole("article").map((article) => article.classList.contains("bg-hover"))).toEqual([false, true]);
  });
});

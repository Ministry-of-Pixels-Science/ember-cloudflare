import type { ClientFrame, Me, Message, Room, ServerFrame } from "@ember/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomFrames } from "@/hooks/use-room";
import { ThreadPanel } from "./thread-panel";

const ada: Me = { id: "u1", name: "Ada", administrator: false };
const grace = { id: "u2", name: "Grace" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  clientMessageId: id,
  roomId: "general",
  creator: ada,
  body: `<p>${id}</p>`,
  plainText: id,
  mentions: [],
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  editedAt: null,
  boosts: [],
  ...overrides,
});
const parent = message("Who has the keys?", { id: "m1", thread: { count: 2, latestAt: "2026-10-12T10:00:00.000Z", people: [grace] } });
const reply = (text: string) => message(text, { id: `r-${text}`, creator: grace, parentId: "m1", alsoSent: false });

/** The room's socket, as the panel listens to and sends on it, which the test plays the room on. */
function roomFrames() {
  const listeners = new Set<(frame: ServerFrame) => void>();
  const send = vi.fn((_frame: ClientFrame) => true);
  const frames: RoomFrames = {
    send,
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const receive = (frame: ServerFrame) => act(() => listeners.forEach((listener) => listener(frame)));
  return { frames, send, receive };
}

function showThread({ deleted = false, replyId = undefined as string | undefined } = {}) {
  const room = roomFrames();
  const { unmount } = render(
    <ThreadPanel room={general} name="general" me={ada} parentId="m1" replyId={replyId} frames={room.frames} status="open" offline={false} deleted={deleted} roomNotice={null} onDismissRoomNotice={() => {}} />,
  );
  return { ...room, unmount, user: userEvent.setup() };
}

class NoObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", NoObserver);
  vi.stubGlobal("ResizeObserver", NoObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe("Threads", () => {
  it("heads the thread with its room, linking back to it, and Close thread", () => {
    showThread();
    const panel = screen.getByRole("complementary", { name: "Thread" });
    expect(within(panel).getByRole("heading", { name: "Thread" })).toBeInTheDocument();
    for (const name of ["general", "Close thread", "Back to general"]) expect(within(panel).getByRole("link", { name })).toHaveAttribute("href", "/rooms/general");
  });

  it("tells the room as it closes, so its replies are pushed again", () => {
    const { send, unmount } = showThread();
    expect(send).not.toHaveBeenCalledWith({ type: "thread.close", parentId: "m1" });
    unmount();
    expect(send).toHaveBeenLastCalledWith({ type: "thread.close", parentId: "m1" });
  });

  it("asks the room for the thread, then shows the message, how many replies it has, and the replies", async () => {
    const { send, receive } = showThread();
    expect(send).toHaveBeenCalledWith({ type: "thread.open", parentId: "m1" });
    receive({ type: "thread.opened", parentId: "m1", parent, messages: [reply("I do"), reply("It's in the cupboard")], hasMore: false });
    const log = screen.getByRole("log", { name: "Thread" });
    expect(within(log).getAllByRole("article").map((article) => article.querySelector(".message-content")!.textContent)).toEqual([
      "Who has the keys?",
      "I do",
      "It's in the cupboard",
    ]);
    expect(within(log).getByText("2 replies")).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Write a reply" })).toBeInTheDocument();
    // Under a room's thread is the window's end, which the people @ lists keep clear of by themselves.
    expect(screen.getByRole("textbox", { name: "Write a reply" })).not.toHaveAttribute("data-mentions-above");
  });

  it("shows @ember typing as it answers in the thread, until its reply comes, but not who types in the room", async () => {
    const { receive } = showThread();
    receive({ type: "thread.opened", parentId: "m1", parent, messages: [reply("I do")], hasMore: false });
    await screen.findByRole("textbox", { name: "Write a reply" });
    const typists = () => document.querySelector(".spinner")!.textContent;
    const ember = { id: "ember", name: "Ember" };

    receive({ type: "typing", user: grace, typing: true });
    expect(typists()).toBe("");
    receive({ type: "typing", user: ember, typing: true, threadId: "m1" });
    expect(typists()).toBe("Ember");
    receive({ type: "message.created", message: message("In the cupboard.", { id: "r-ember", creator: ember, parentId: "m1", alsoSent: false }), seq: 3 });
    expect(typists()).toBe("");
  });

  it("pages back to the reply its permalink names, older than the newest, a page at a time", () => {
    const { send, receive } = showThread({ replyId: "r-a" });
    const pagesBack = () => send.mock.calls.flatMap(([frame]) => (frame.type === "thread.before" ? [frame.before] : []));
    receive({ type: "thread.opened", parentId: "m1", parent, messages: [reply("e"), reply("f")], hasMore: true });
    expect(pagesBack()).toEqual(["r-e"]);
    receive({ type: "thread.history", parentId: "m1", before: "r-e", messages: [reply("c"), reply("d")], hasMore: true });
    expect(pagesBack()).toEqual(["r-e", "r-c"]);
    receive({ type: "thread.history", parentId: "m1", before: "r-c", messages: [reply("a"), reply("b")], hasMore: true });
    expect(pagesBack()).toEqual(["r-e", "r-c"]);
    expect(screen.getAllByRole("article").map((article) => article.querySelector(".message-content")!.textContent)).toEqual(["Who has the keys?", "a", "b", "c", "d", "e", "f"]);
  });

  it("says the message is gone, with nothing to reply in, when the room hasn't it", () => {
    const { receive } = showThread();
    receive({ type: "thread.opened", parentId: "m1", parent: null, messages: [], hasMore: false });
    expect(screen.getByText("This message no longer exists.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Write a reply" })).not.toBeInTheDocument();
  });

  it("sends a reply in the thread, and to the room too when asked", async () => {
    const { send, receive, user } = showThread();
    receive({ type: "thread.opened", parentId: "m1", parent, messages: [], hasMore: false });
    const box = await screen.findByRole("textbox", { name: "Write a reply" });
    await user.type(box, "On my way{Enter}");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "message.create", body: "<p>On my way</p>", parentId: "m1", alsoSend: false }));

    await user.click(screen.getByRole("checkbox", { name: "Also send to #general" }));
    await user.type(box, "Found them{Enter}");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "message.create", body: "<p>Found them</p>", parentId: "m1", alsoSend: true }));
  });

  it("says the room was deleted in place of the composer", () => {
    const { receive } = showThread({ deleted: true });
    receive({ type: "thread.opened", parentId: "m1", parent, messages: [], hasMore: false });
    expect(screen.getByRole("alert")).toHaveTextContent("This room was deleted.");
    expect(screen.queryByRole("textbox", { name: "Write a reply" })).not.toBeInTheDocument();
  });
});

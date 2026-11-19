import type { Boost, Message, ServerFrame, User } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { isPending, type PendingMessage } from "./room-state";
import { initialThreadState, threadReducer, type ThreadState } from "./thread-state";

const ada: User = { id: "u1", name: "Ada" };
const grace: User = { id: "u2", name: "Grace" };
const message = (overrides: Partial<Message> = {}): Message => ({
  id: "m1",
  clientMessageId: "c1",
  roomId: "general",
  creator: ada,
  body: "hi",
  plainText: "hi",
  mentions: [],
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  editedAt: null,
  boosts: [],
  ...overrides,
});

const parent = message();
/** A reply in m1's thread. */
const reply = (id: string, overrides: Partial<Message> = {}) => message({ id, clientMessageId: `c-${id}`, creator: grace, parentId: "m1", alsoSent: false, ...overrides });
const boost = (id: string, messageId: string): Boost => ({ id, messageId, booster: ada, content: "👍", createdAt: "" });

const frame = (state: ThreadState, f: ServerFrame) => threadReducer(state, { type: "frame", frame: f, now: 0 });
/** The room answering thread.open for m1 with `replies`, its newest unless `hasMore`. */
const opened = (state: ThreadState, replies: Message[], { hasMore = false, of = parent as Message | null } = {}) =>
  frame(state, { type: "thread.opened", parentId: "m1", parent: of, messages: replies, hasMore });
const ids = (state: ThreadState) => state.replies.messages.map((m) => m.id);

describe("Open a thread", () => {
  it("shows the message and its newest replies, at their end", () => {
    const state = opened(initialThreadState({ parentId: "m1" }), [reply("r1"), reply("r2")]);
    expect(state.parent).toEqual(parent);
    expect(ids(state)).toEqual(["r1", "r2"]);
    expect(state.replies.status).toBe("open");
    expect(state.replies.focus).toEqual({ messageId: null });
  });

  it("goes to the reply its permalink names, paging back to an older one, and to the end when it has no such reply", () => {
    const atReply = opened(initialThreadState({ parentId: "m1", replyId: "r1" }), [reply("r1"), reply("r2")]);
    expect(atReply.replies.focus).toEqual({ messageId: "r1" });
    expect(atReply.openingAt).toBeUndefined();

    let older = opened(initialThreadState({ parentId: "m1", replyId: "r1" }), [reply("r3"), reply("r4")], { hasMore: true });
    expect(older.openingAt).toBe("r1");
    older = threadReducer(older, { type: "loading-older" });
    older = frame(older, { type: "thread.history", parentId: "m1", before: "r3", messages: [reply("r1"), reply("r2")], hasMore: true });
    expect(older.replies.focus).toEqual({ messageId: "r1" });
    expect(older.openingAt).toBeUndefined();

    // One that would be among those it has, or older than every reply, isn't there.
    const deleted = opened(initialThreadState({ parentId: "m1", replyId: "r3a" }), [reply("r3"), reply("r4")], { hasMore: true });
    expect(deleted.replies.focus).toEqual({ messageId: null });
    let tooOld = opened(initialThreadState({ parentId: "m1", replyId: "r0" }), [reply("r3")], { hasMore: true });
    tooOld = frame(threadReducer(tooOld, { type: "loading-older" }), { type: "thread.history", parentId: "m1", before: "r3", messages: [reply("r1")], hasMore: false });
    expect(tooOld.replies.focus).toEqual({ messageId: null });
    expect(tooOld.openingAt).toBeUndefined();
  });

  it("goes to a reply as its permalink is followed, even before it has opened, until the reader goes to the end, or a page back fails", () => {
    const early = threadReducer(initialThreadState({ parentId: "m1" }), { type: "open-at", replyId: "r1" });
    expect(opened(early, [reply("r1"), reply("r2")]).replies.focus).toEqual({ messageId: "r1" });

    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r3"), reply("r4")], { hasMore: true });
    state = threadReducer(state, { type: "open-at", replyId: "r4" });
    expect(state.replies.focus).toEqual({ messageId: "r4" });
    state = threadReducer(state, { type: "open-at", replyId: "r1" });
    expect(state.openingAt).toBe("r1");
    state = threadReducer(state, { type: "focus", messageId: null });
    expect(state.openingAt).toBeUndefined();
    expect(state.replies.focus).toEqual({ messageId: null });

    state = threadReducer(threadReducer(state, { type: "open-at", replyId: "r1" }), { type: "loading-older" });
    state = frame(state, { type: "error", message: "Something went wrong", failed: "thread.before" });
    expect(state.openingAt).toBeUndefined();
    expect(state.replies.loadingOlder).toBe(false);
  });

  it("says the message is gone when the room has no such message", () => {
    const state = opened(initialThreadState({ parentId: "m1" }), [], { of: null });
    expect(state.parent).toBeNull();
    expect(state.replies.status).toBe("open");
  });

  it("leaves another thread's frames, and the room's own, to them", () => {
    const state = opened(initialThreadState({ parentId: "m1" }), [reply("r1")]);
    const other = message({ id: "x1", clientMessageId: "cx", parentId: "m9" });
    expect(frame(state, { type: "thread.opened", parentId: "m9", parent: message({ id: "m9" }), messages: [other], hasMore: false })).toBe(state);
    expect(frame(state, { type: "thread.history", parentId: "m9", before: "x2", messages: [other], hasMore: false })).toBe(state);
    expect(frame(state, { type: "message.created", message: other, seq: 1 })).toBe(state);
    expect(frame(state, { type: "message.created", message: message({ id: "m2", clientMessageId: "c2" }), seq: 2 })).toBe(state);
    expect(frame(state, { type: "presence.joined", user: ada })).toBe(state);
    expect(frame(state, { type: "typing", user: ada, typing: true })).toBe(state);
    expect(frame(state, { type: "typing", user: ada, typing: true, threadId: "m9" })).toBe(state);
  });

  it("has its message once the room writes it, as a huddle's thread can be open before its message is there, and as the room tells of it again", () => {
    const without = opened(initialThreadState({ parentId: "m1" }), [], { of: null });
    const written = frame(without, { type: "message.created", message: parent, seq: 1 });
    expect(written.parent).toEqual(parent);
    expect(written.replies).toBe(without.replies);

    const told = message({ updatedAt: "2026-10-12T10:05:00.000Z" });
    expect(frame(written, { type: "message.created", message: told, seq: 2 }).parent).toEqual(told);
  });
});

describe("Follow a thread as it changes", () => {
  it("shows who types in it, as @ember does while it answers there, until their reply comes, they stop, or the thread stops hearing of it", () => {
    const ember: User = { id: "ember", name: "Ember" };
    const state = opened(initialThreadState({ parentId: "m1" }), [reply("r1")]);
    const typing = threadReducer(state, { type: "frame", frame: { type: "typing", user: ember, typing: true, threadId: "m1" }, now: 1_000 });
    expect(typing.replies.typing).toEqual({ ember: { user: ember, at: 1_000 } });
    expect(frame(typing, { type: "message.created", message: reply("r2", { creator: ember }), seq: 2 }).replies.typing).toEqual({});
    expect(frame(typing, { type: "typing", user: ember, typing: false, threadId: "m1" }).replies.typing).toEqual({});
    expect(threadReducer(typing, { type: "expire-typing", before: 1_000 })).toBe(typing);
    expect(threadReducer(typing, { type: "expire-typing", before: 2_000 }).replies.typing).toEqual({});
    // What it says it's doing meanwhile goes with it.
    const using = threadReducer(state, { type: "frame", frame: { type: "typing", user: ember, typing: true, threadId: "m1", doing: "is searching this room" }, now: 1_000 });
    expect(using.replies.typing).toEqual({ ember: { user: ember, at: 1_000, doing: "is searching this room" } });
  });

  it("adds new replies, and changes or takes away those that change or go", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r1")]);
    state = frame(state, { type: "message.created", message: reply("r2"), seq: 1 });
    expect(ids(state)).toEqual(["r1", "r2"]);
    state = frame(state, { type: "message.updated", message: reply("r1", { body: "edited" }), seq: 2 });
    expect(state.replies.messages[0]!.body).toBe("edited");
    state = frame(state, { type: "message.deleted", messageId: "r2", seq: 3 });
    expect(ids(state)).toEqual(["r1"]);
  });

  it("keeps the message's changes, its reactions, and its going, after which its replies stay", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r1")]);
    state = frame(state, { type: "message.updated", message: message({ body: "edited", thread: { count: 1, latestAt: "", people: [grace] } }), seq: 1 });
    expect(state.parent!.body).toBe("edited");
    state = frame(state, { type: "boost.created", boost: boost("b1", "m1"), seq: 2 });
    expect(state.parent!.boosts.map((b) => b.id)).toEqual(["b1"]);
    state = frame(state, { type: "boost.created", boost: boost("b2", "r1"), seq: 3 });
    expect(state.replies.messages[0]!.boosts.map((b) => b.id)).toEqual(["b2"]);
    state = frame(state, { type: "boost.deleted", boostId: "b1", messageId: "m1", seq: 4 });
    expect(state.parent!.boosts).toEqual([]);

    state = frame(state, { type: "message.deleted", messageId: "m1", seq: 5 });
    expect(state.parent).toBeNull();
    expect(ids(state)).toEqual(["r1"]);
  });

  it("pages back through older replies", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r3"), reply("r4")], { hasMore: true });
    expect(state.replies.oldestId).toBe("r3");
    state = frame(state, { type: "thread.history", parentId: "m1", before: "r3", messages: [reply("r1"), reply("r2")], hasMore: false });
    expect(ids(state)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(state.replies.hasMore).toBe(false);
  });

  it("keeps the reader's place as the room lets the page in again, catching up with what changed while it was away", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r1"), reply("r2"), reply("r3")]);
    state = threadReducer(state, { type: "focus", messageId: "r2" });
    state = threadReducer(state, { type: "status", status: "reconnecting" });
    state = opened(state, [reply("r1"), reply("r3", { body: "edited" }), reply("r4")]);
    expect(ids(state)).toEqual(["r1", "r3", "r4"]);
    expect(state.replies.messages[1]!.body).toBe("edited");
    expect(state.replies.focus).toEqual({ messageId: "r2" });
    expect(state.replies.status).toBe("open");
  });

  it("shows the newest page in place of its replies once they go back further, for paging back to bring the older ones as they are now", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r1"), reply("r2")]);
    state = threadReducer(state, { type: "pending", message: { ...reply("c3", { clientMessageId: "c3" }), pending: true } });
    state = threadReducer(state, { type: "status", status: "reconnecting" });
    state = opened(state, [reply("r5"), reply("r6")], { hasMore: true });
    expect(ids(state)).toEqual(["r5", "r6", "c3"]);
    expect(state.replies).toMatchObject({ hasMore: true, oldestId: "r5", status: "open" });

    // Even when the page holds some of them.
    state = frame(state, { type: "thread.history", parentId: "m1", before: "r5", messages: [reply("r3"), reply("r4")], hasMore: true });
    state = opened(state, [reply("r4"), reply("r5", { body: "edited" }), reply("r7")], { hasMore: true });
    expect(ids(state)).toEqual(["r4", "r5", "r7", "c3"]);
    expect(state.replies.messages[1]!.body).toBe("edited");

    // A thread that had none yet pages back from the page too.
    state = opened(opened(initialThreadState({ parentId: "m1" }), []), [reply("r5"), reply("r6")], { hasMore: true });
    expect(state.replies).toMatchObject({ hasMore: true, oldestId: "r5" });
  });

  it("keeps every reply it pages back to, its newest too, and the replies that come after", () => {
    const replies = Array.from({ length: 400 }, (_, i) => reply(`r${String(i).padStart(3, "0")}`));
    let state = opened(initialThreadState({ parentId: "m1" }), replies.slice(-40), { hasMore: true });
    for (let end = 360; end > 0; end -= 40) {
      state = frame(state, { type: "thread.history", parentId: "m1", before: replies[end]!.id, messages: replies.slice(end - 40, end), hasMore: end > 40 });
    }
    expect(ids(state)).toEqual(replies.map((r) => r.id));
    expect(state.replies.hasNewer).toBe(false);
    state = frame(state, { type: "message.created", message: reply("r400"), seq: 1 });
    expect(ids(state)).toHaveLength(401);
    expect(ids(state).at(-1)).toBe("r400");
  });
});

describe("Reply in a thread", () => {
  const sending = (id: string): PendingMessage => ({ ...reply(id, { id, clientMessageId: id }), pending: true });

  it("shows a reply as sending until the room has it, and as not sent if the room refuses it", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r1")]);
    state = threadReducer(state, { type: "pending", message: sending("c2") });
    expect(state.replies.messages.map((m) => [m.id, isPending(m)])).toEqual([
      ["r1", false],
      ["c2", true],
    ]);
    state = frame(state, { type: "message.created", message: reply("r2", { clientMessageId: "c2" }), seq: 1 });
    expect(state.replies.messages.map((m) => [m.id, isPending(m)])).toEqual([
      ["r1", false],
      ["r2", false],
    ]);

    state = threadReducer(state, { type: "pending", message: sending("c3") });
    state = frame(state, { type: "error", message: "That message no longer exists", clientMessageId: "c3", failed: "message.create" });
    const refused = state.replies.messages[2] as PendingMessage;
    expect(refused.failed).toBe(true);
    expect(state.replies.notice).toBe("That message no longer exists");
  });

  it("leaves the room's own refusals to the room, and says why its replies' page didn't come, so it can be asked again", () => {
    let state = opened(initialThreadState({ parentId: "m1" }), [reply("r3")], { hasMore: true });
    expect(frame(state, { type: "error", message: "Not sent", clientMessageId: "c-room", failed: "message.create" })).toBe(state);
    expect(frame(state, { type: "error", message: "Couldn't load older messages", failed: "history.before" })).toBe(state);

    state = threadReducer(state, { type: "loading-older" });
    state = frame(state, { type: "error", message: "Couldn't load the thread", failed: "thread.before" });
    expect(state.replies.loadingOlder).toBe(false);
    expect(state.replies.notice).toBe("Couldn't load the thread");
  });

  it("brings back a reaction the room wouldn't take away, as the room does", () => {
    const state = frame(opened(initialThreadState({ parentId: "m1" }), [reply("r1")]), { type: "error", message: "Not removed", failed: "boost.delete" });
    expect(state.replies.refusedUnboosts).toBe(1);
  });
});

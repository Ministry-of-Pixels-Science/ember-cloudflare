import { HISTORY_PAGE_SIZE, parentTextOf, type Message, type ServerFrame, type TimelinePage, type User } from "@ember/protocol";

/** `gone` is a room that isn't there for this person any more, deleted or no longer theirs, which nothing reconnects to. */
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "gone";

/**
 * The most messages the timeline keeps, and how many more it takes before it's cut back to that, as
 * Campfire's message_paginator.js keeps the page's (`MAX_MESSAGES`, `MAX_MESSAGES_LEEWAY`).
 */
export const MAX_MESSAGES = 300;
export const MAX_MESSAGES_LEEWAY = 20;

export interface PendingMessage extends Message {
  pending: true;
  failed?: boolean;
  /** Written without a connection, to send once the room lets one in again, unless the page goes offline first. */
  queued?: boolean;
  /** Which of the connections the room let this page in on, as `connections` counts them, it went over. */
  sentOver?: number;
  /** A file on its way to becoming a message of its own, which its card shows in the message's place. */
  upload?: PendingUpload;
}

/** A file being uploaded, as its card shows it. */
export interface PendingUpload {
  name: string;
  size: number;
  /** How much of it has gone, as a percentage rounded down. */
  percent: number;
  /** Why it failed, once it has. */
  error?: string;
}

/**
 * Where the timeline goes next: to a message, centred and outlined, as its permalink opens the room, or
 * to its end, when it names none. Each is a new object, so going to the same place again goes again.
 */
export interface Focus {
  messageId: string | null;
}

/** What a message that couldn't go says, as the room's own refusals do. */
const NOT_SENT = "Not connected. Your message wasn't sent.";

export interface RoomState {
  status: ConnectionStatus;
  /** Whether the room has been without a connection for 5 seconds, which stops sending until it's back. */
  offline: boolean;
  /** The timeline's messages, oldest first, followed by those this page sent that the room hasn't confirmed. */
  messages: Array<Message | PendingMessage>;
  present: User[];
  /** Who is typing, with when we last heard so stale entries can expire. */
  typing: Record<string, { user: User; at: number }>;
  /** Whether the room has messages older than the timeline holds. */
  hasMore: boolean;
  /**
   * Whether it has newer ones, as when it opened at a permalink, or once paging back has cut the newest
   * off: Campfire's paginator isn't `upToDate` then. New messages wait for the timeline to page forward
   * to them, rather than show after the gap, and count as `arrivals`.
   */
  hasNewer: boolean;
  /**
   * The oldest message the room has sent this page, which history pages back from. It stays when that
   * message is deleted, so a timeline whose messages were all deleted can still page back to older ones.
   */
  oldestId: string | null;
  /** The newest the room has sent the timeline, which, while it has newer ones, history pages forward from. It stays when deleted, too. */
  newestId: string | null;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** Whether a page to take the timeline's place is on its way: the newest, or the one around a message. */
  loadingPage: boolean;
  /** Where the timeline goes next, or null until the room has said what it holds. */
  focus: Focus | null;
  /** How many times messages have come from the room, other than this page's own: the timeline shows Jump to newest message when one comes out of view. */
  arrivals: number;
  notice: string | null;
  /**
   * Whether the room had more than a page of messages (`HISTORY_PAGE_SIZE`) when it first answered, or null until then.
   * Once it's known, it holds until the room is opened again.
   */
  paged: boolean | null;
  /**
   * How many times the room has let this page in, with a welcome or a resume. A change sent before the
   * latest may never have reached the room.
   */
  connections: number;
  /**
   * How many times the room has answered a reaction's deletion with an error, as it does from a banned
   * address. It doesn't say which reaction, so a deletion sent before the latest may not happen.
   */
  refusedUnboosts: number;
  /**
   * Set for a timeline that keeps every message it's sent, as a thread's does: it has no way to page
   * forward, so it can't cut its newest, and then it can't cut its oldest either, which may be the ones
   * being read.
   */
  keepsAll?: true;
}

export type RoomAction =
  | { type: "reset" }
  | { type: "status"; status: ConnectionStatus }
  | { type: "offline"; offline: boolean }
  | { type: "frame"; frame: ServerFrame; now: number }
  | { type: "pending"; message: PendingMessage }
  /** What this page left unsent here when the room, or the thread, was last left, as the outbox kept it since. */
  | { type: "kept"; messages: PendingMessage[] }
  | { type: "sent"; clientMessageIds: string[] }
  | { type: "upload-progress"; clientMessageId: string; percent: number }
  | { type: "upload-failed"; clientMessageId: string; error: string }
  /** The message a file was posted as, as its upload's last part answers with it. */
  | { type: "uploaded"; message: Message }
  | { type: "loading-older" }
  | { type: "loading-newer" }
  | { type: "loading-page" }
  /** Goes to a message the timeline holds, or to its end when it holds the newest. */
  | { type: "focus"; messageId: string | null }
  | { type: "expire-typing"; before: number }
  /** Says why something written didn't go, as the room says why it refused something. */
  | { type: "warn"; message: string }
  | { type: "dismiss-notice" };

export const initialRoomState: RoomState = {
  status: "connecting",
  offline: false,
  messages: [],
  present: [],
  typing: {},
  hasMore: false,
  hasNewer: false,
  oldestId: null,
  newestId: null,
  loadingOlder: false,
  loadingNewer: false,
  loadingPage: false,
  focus: null,
  arrivals: 0,
  notice: null,
  paged: null,
  connections: 0,
  refusedUnboosts: 0,
};

export const isPending = (m: Message | PendingMessage): m is PendingMessage => "pending" in m;

/**
 * Whether `stored` is the room's copy of the optimistic message `m`. Anyone can send a
 * clientMessageId they've seen, so the sender has to match as well.
 */
const confirms = (stored: Message, m: Message | PendingMessage) =>
  isPending(m) && m.clientMessageId === stored.clientMessageId && m.creator.id === stored.creator.id;

/** The pending messages whose stored copies aren't in `snapshot`, the newest page a reconnect brings. */
export const unconfirmed = (messages: RoomState["messages"], snapshot: Message[]) =>
  messages.filter((m): m is PendingMessage => isPending(m) && !snapshot.some((stored) => confirms(stored, m)));

const byId = (a: Message, b: Message) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** What changed while the page was away: the messages changed, as they are now, and the ids of those deleted. */
export interface Changes {
  messages: Message[];
  deletedIds: string[];
}

/**
 * The page's messages caught up with what changed while it was away, as `resumed` says. Deleted messages
 * go, changed ones are replaced, and new ones take their places by id, except those outside the
 * timeline: older than the oldest the room has sent, or, while it has newer ones, newer than the newest,
 * which history brings as they are once it's paged to. The messages sent before the connection dropped
 * that none confirms stay as sending while useRoom asks the room about them, as after a welcome: one may
 * be older than the page a welcome before brought, which nothing since names. And whether any came newer
 * than the timeline's end.
 */
function caughtUp({ messages, oldestId, newestId, hasNewer }: RoomState, { messages: changed, deletedIds }: Changes) {
  const deleted = new Set(deletedIds);
  const updates = new Map(changed.map((m) => [m.id, m]));
  const stored = messages.filter((m) => !isPending(m));
  const kept = stored.flatMap((m) => (deleted.has(m.id) ? [] : [updates.get(m.id) ?? m]));
  const loaded = new Set(stored.map((m) => m.id));
  const end = hasNewer ? newestId : null;
  const added = changed.filter((m) => !loaded.has(m.id) && (oldestId === null || m.id > oldestId) && (end === null || m.id < end));
  const newest = stored.at(-1)?.id ?? newestId;
  const came = changed.some((m) => !loaded.has(m.id) && (newest === null || m.id > newest));
  return { messages: [...retold([...kept, ...added], changed).sort(byId), ...unconfirmed(messages, changed)], came };
}

/**
 * The timeline in place of the one shown: `page`, and after it the messages this page sent that it doesn't
 * confirm, which wait for the room as they were.
 */
const showing = (state: RoomState, page: TimelinePage) => ({
  messages: [...page.messages, ...unconfirmed(state.messages, page.messages)],
  hasMore: page.hasMore,
  hasNewer: page.hasNewer,
  oldestId: page.messages[0]?.id ?? null,
  newestId: page.messages.at(-1)?.id ?? null,
  focus: { messageId: page.around },
});

/**
 * The timeline cut back to `MAX_MESSAGES` once it holds more than `MAX_MESSAGES_LEEWAY` over: from its
 * start after it grows at the end, and from its end after it grows at the start, as Campfire's paginator
 * drops the end the reader is furthest from. What's cut is paged to again from the new `oldestId` or
 * `newestId`. Messages waiting for the room aren't cut, nor is a timeline that `keepsAll`.
 */
function cut(state: RoomState, from: "start" | "end"): RoomState {
  const stored = state.messages.filter((m) => !isPending(m));
  const over = stored.length - MAX_MESSAGES;
  if (over <= MAX_MESSAGES_LEEWAY || state.keepsAll) return state;
  const dropped = new Set((from === "start" ? stored.slice(0, over) : stored.slice(-over)).map((m) => m.id));
  const messages = state.messages.filter((m) => isPending(m) || !dropped.has(m.id));
  return from === "start"
    ? { ...state, messages, hasMore: true, oldestId: stored[over]!.id }
    : { ...state, messages, hasNewer: true, newestId: stored[stored.length - over - 1]!.id };
}

const replace = (messages: RoomState["messages"], id: string, update: (m: Message) => Message) =>
  messages.map((m) => (m.id === id ? update(m) : m));

/**
 * The timeline with the replies to `changed` messages showing the start of their text as it is now, as a
 * reply also sent to the room shows it: once a message is edited, or deleted with its thread left.
 */
function retold(messages: RoomState["messages"], changed: Message[]): RoomState["messages"] {
  const texts = new Map(changed.map((m) => [m.id, parentTextOf(m.plainText)]));
  const told = messages.map((m) => {
    const text = m.parentId === undefined ? undefined : texts.get(m.parentId);
    return text === undefined || text === m.parentText ? m : { ...m, parentText: text };
  });
  return told.every((m, i) => m === messages[i]) ? messages : told;
}

/** The timeline with the upload this page sent as `clientMessageId` changed by `update`, while it's still on its way. */
const uploading = (messages: RoomState["messages"], clientMessageId: string, update: (upload: PendingUpload) => PendingUpload) =>
  messages.map((m) => (isPending(m) && m.upload && m.clientMessageId === clientMessageId ? { ...m, upload: update(m.upload) } : m));

/**
 * `message` as the room stored it. A confirmed message goes where the room put it, at the end, not where
 * its optimistic copy sat: the room may have stored someone else's first. One the timeline has already,
 * as when an upload's answer and the room both bring it, stays where it is.
 */
function received(state: RoomState, message: Message): RoomState {
  const others = state.messages.filter((m) => !confirms(message, m));
  const typing = withoutTyping(state.typing, message.creator.id);
  const shown = others.some((m) => m.id === message.id);
  const arrivals = others.length < state.messages.length || shown ? state.arrivals : state.arrivals + 1;
  // A timeline that doesn't hold the newest messages shows this one once it pages forward to it, rather
  // than after the gap.
  if (state.hasNewer) return { ...state, messages: others, typing, arrivals };
  const messages = shown ? replace(others, message.id, () => message) : [...others, message];
  return cut({ ...state, messages, typing, arrivals }, "start");
}

export const isQueued = (m: Message | PendingMessage): m is PendingMessage => isPending(m) && m.queued === true;

export const dequeued = ({ queued: _, ...message }: PendingMessage): PendingMessage => message;

/** The messages waiting for a connection, shown as not sent. */
export const notSent = <M extends Message>(messages: M[]): Array<M | PendingMessage> => messages.map((m) => (isQueued(m) ? { ...dequeued(m), failed: true } : m));

/** Offline, the messages waiting for a connection show as not sent, and say so. */
function unsent(state: RoomState): RoomState {
  if (!state.offline || !state.messages.some(isQueued)) return state;
  return { ...state, messages: notSent(state.messages), notice: NOT_SENT };
}

function withoutTyping(typing: RoomState["typing"], userId: string) {
  if (!(userId in typing)) return typing;
  const { [userId]: _, ...rest } = typing;
  return rest;
}

/** Who is typing once the room has said that `frame`'s user started or stopped, heard at `now`. */
export function typed(typing: RoomState["typing"], { user, typing: started }: Extract<ServerFrame, { type: "typing" }>, now: number): RoomState["typing"] {
  return started ? { ...typing, [user.id]: { user, at: now } } : withoutTyping(typing, user.id);
}

/**
 * The timeline as the room lets a connection in with a welcome, `page` in its place, and `present` there.
 * Unconfirmed messages stay across a reconnect, and everything else comes fresh from the room: the old
 * socket may have closed after the room stored one, so those it sent stay as sending while useRoom asks
 * the room about them.
 */
export function welcomed(state: RoomState, page: TimelinePage, present: User[]): RoomState {
  return {
    ...state,
    ...showing(state, page),
    status: "open",
    present,
    // A history request on the old socket will never be answered.
    loadingOlder: false,
    loadingNewer: false,
    loadingPage: false,
    typing: {},
    // Whatever the page: whether the room has more than a page of messages.
    paged: state.paged ?? (page.hasMore || page.hasNewer || page.messages.length > HISTORY_PAGE_SIZE),
    connections: state.connections + 1,
  };
}

/**
 * The timeline as the room lets a connection in again with what `changed` while it was away, and `present`
 * there. The pages already loaded stay, older ones included, where a welcome would replace them.
 */
export function resumed(state: RoomState, changed: Changes, present: User[]): RoomState {
  const { messages, came } = caughtUp(state, changed);
  return cut(
    {
      ...state,
      status: "open",
      messages,
      present,
      // A history request on the old socket will never be answered.
      loadingOlder: false,
      loadingNewer: false,
      loadingPage: false,
      typing: {},
      arrivals: came ? state.arrivals + 1 : state.arrivals,
      connections: state.connections + 1,
    },
    "start",
  );
}

/** The timeline with the page before `before` that history brings, `messages`, oldest first, and whether there are older ones still. */
export function paged(state: RoomState, { before, messages: page, hasMore }: { before: string; messages: Message[]; hasMore: boolean }): RoomState {
  // A page asked for before the timeline took another's place, or was cut, pages from where it no longer starts.
  if (before !== state.oldestId) return { ...state, loadingOlder: false };
  // A page can hold the stored copy of a message that a reconnect left unconfirmed.
  const messages = state.messages.filter((m) => !page.some((stored) => confirms(stored, m)));
  return cut({ ...state, messages: [...page, ...messages], hasMore, oldestId: page[0]?.id ?? state.oldestId, loadingOlder: false }, "end");
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "reset":
      return initialRoomState;
    case "status":
      // Nobody shows as here with this person in a room that's gone, which nothing connects to again, so
      // what was waiting for a connection shows as not sent.
      return action.status === "gone"
        ? { ...state, status: action.status, offline: false, present: [], typing: {}, messages: notSent(state.messages) }
        : { ...state, status: action.status };
    case "offline":
      return action.offline ? unsent({ ...state, offline: true }) : { ...state, offline: false };
    case "pending": {
      // Sending goes to the end of the timeline, as Campfire's insertPendingMessage scrolls there, once
      // the newest page has come, which useRoom asks for first when the timeline doesn't hold it.
      const focus = state.hasNewer || state.loadingPage ? state.focus : { messageId: null };
      // A file goes over HTTP, and one written while the room was away over no connection yet.
      const message = action.message.queued || action.message.upload ? action.message : { ...action.message, sentOver: state.connections };
      return unsent({ ...state, messages: [...state.messages, message], focus });
    }
    // After the timeline, as what waits for the room is, leaving it where it is. What went, went over the
    // outbox's socket or an earlier view's, none of this one's. A view opened twice over, as React opens it
    // in development, takes them back twice.
    case "kept": {
      const kept = action.messages.flatMap(({ sentOver: _, ...k }) => (state.messages.some((m) => isPending(m) && m.clientMessageId === k.clientMessageId) ? [] : [k]));
      return kept.length === 0 ? state : { ...state, messages: [...state.messages, ...kept] };
    }
    case "sent": {
      const sent = (m: Message | PendingMessage): m is PendingMessage => isQueued(m) && action.clientMessageIds.includes(m.clientMessageId);
      return { ...state, messages: state.messages.map((m) => (sent(m) ? { ...dequeued(m), sentOver: state.connections } : m)) };
    }
    case "upload-progress":
      return { ...state, messages: uploading(state.messages, action.clientMessageId, (upload) => ({ ...upload, percent: action.percent })) };
    // An upload whose message the room has brought already stays posted, as its answer may be lost after
    // the room has stored it.
    case "upload-failed":
      return { ...state, messages: uploading(state.messages, action.clientMessageId, (upload) => ({ ...upload, error: action.error })) };
    // The room's broadcast usually brings the message first, and then anything done to it since, which the
    // upload's answer, sent as it was posted, would undo: it's for an upload whose card is still waiting.
    case "uploaded":
      return state.messages.some((m) => isPending(m) && m.upload && m.clientMessageId === action.message.clientMessageId) ? received(state, action.message) : state;
    case "loading-older":
      return { ...state, loadingOlder: true };
    case "loading-newer":
      return { ...state, loadingNewer: true };
    case "loading-page":
      return { ...state, loadingPage: true };
    case "focus":
      return { ...state, focus: { messageId: action.messageId } };
    case "warn":
      return { ...state, notice: action.message };
    case "dismiss-notice":
      return { ...state, notice: null };
    case "expire-typing": {
      const fresh = Object.entries(state.typing).filter(([, t]) => t.at >= action.before);
      // This comes every second, so a room where nothing expired keeps its state and doesn't re-render.
      return fresh.length === Object.keys(state.typing).length ? state : { ...state, typing: Object.fromEntries(fresh) };
    }
    case "frame":
      return applyFrame(state, action.frame, action.now);
  }
}

function applyFrame(state: RoomState, frame: ServerFrame, now: number): RoomState {
  switch (frame.type) {
    case "welcome":
      return welcomed(state, frame, frame.present);
    case "resumed":
      return resumed(state, frame, frame.present);
    case "message.created":
      return received(state, frame.message);
    case "message.updated":
      return { ...state, messages: retold(replace(state.messages, frame.message.id, () => frame.message), [frame.message]) };
    case "message.deleted":
      return { ...state, messages: state.messages.filter((m) => m.id !== frame.messageId) };
    case "boost.created":
      return {
        ...state,
        messages: replace(state.messages, frame.boost.messageId, (m) => ({ ...m, boosts: [...m.boosts, frame.boost] })),
      };
    case "boost.deleted":
      return {
        ...state,
        messages: replace(state.messages, frame.messageId, (m) => ({ ...m, boosts: m.boosts.filter((b) => b.id !== frame.boostId) })),
      };
    case "presence.joined":
      // Someone reopening the room while their last tab is still closing arrives before that tab leaves.
      return state.present.some((u) => u.id === frame.user.id) ? state : { ...state, present: [...state.present, frame.user] };
    case "presence.left":
      return { ...state, present: state.present.filter((u) => u.id !== frame.userId), typing: withoutTyping(state.typing, frame.userId) };
    case "typing":
      // Typing in a thread, as @ember's while it answers there, shows in the thread (`threadReducer`).
      return frame.threadId === undefined ? { ...state, typing: typed(state.typing, frame, now) } : state;
    case "message.checked": {
      const among = (ids: string[]) => (m: Message | PendingMessage): m is PendingMessage => isPending(m) && ids.includes(m.clientMessageId);
      const stored = among(frame.stored);
      const missing = among(frame.missing);
      // The room stored these before the oldest message of the snapshot it sent on reconnect, so they
      // belong in older history, where scrolling up finds them.
      const sent = state.messages.filter(stored).length;
      // An upload the room never posted keeps its card, which says why.
      const messages = state.messages.flatMap((m) => (stored(m) ? [] : missing(m) && !m.upload ? [{ ...m, failed: true }] : [m]));
      const notice = sent === 0 ? state.notice : sent === 1 ? "Your message was sent. Scroll up to see it." : "Your messages were sent. Scroll up to see them.";
      return { ...state, messages, notice };
    }
    case "history":
      return paged(state, frame);
    case "history.after": {
      if (!state.hasNewer || frame.after !== state.newestId) return { ...state, loadingNewer: false };
      const waiting = state.messages.filter((m) => isPending(m) && !frame.messages.some((stored) => confirms(stored, m)));
      return cut(
        {
          ...state,
          messages: [...state.messages.filter((m) => !isPending(m)), ...frame.messages, ...waiting],
          hasNewer: frame.hasNewer,
          newestId: frame.messages.at(-1)?.id ?? state.newestId,
          loadingNewer: false,
        },
        "start",
      );
    }
    case "history.around":
      return { ...state, ...showing(state, frame), loadingPage: false };
    case "error": {
      // A message the room refused shows as not sent, as do the ones it couldn't check. An error about no
      // message keeps the same list: the timeline takes a new one for a change, and would ask again for a
      // page that just failed. One about a thread, or about messages the timeline isn't sending, as
      // replies in a thread, is the thread's to show.
      const notSent = frame.clientMessageIds ?? (frame.clientMessageId === undefined ? [] : [frame.clientMessageId]);
      if (frame.failed === "thread.open" || frame.failed === "thread.before") return state;
      if (notSent.length > 0 && !state.messages.some((m) => isPending(m) && notSent.includes(m.clientMessageId))) return state;
      const messages = notSent.length
        ? state.messages.map((m) => (isPending(m) && notSent.includes(m.clientMessageId) ? { ...m, failed: true } : m))
        : state.messages;
      // A failed history request leaves nothing in flight, so paging can be tried again.
      return {
        ...state,
        messages,
        notice: frame.message,
        loadingOlder: frame.failed === "history.before" ? false : state.loadingOlder,
        loadingNewer: frame.failed === "history.after" ? false : state.loadingNewer,
        loadingPage: frame.failed === "history.around" ? false : state.loadingPage,
        refusedUnboosts: frame.failed === "boost.delete" ? state.refusedUnboosts + 1 : state.refusedUnboosts,
      };
    }
    // A thread's, which its own state keeps, and a click's answer, which its button waits for.
    case "thread.opened":
    case "thread.history":
    case "card.clicked":
    case "pong":
      return state;
  }
}

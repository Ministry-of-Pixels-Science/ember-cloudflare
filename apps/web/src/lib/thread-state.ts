import type { Boost, Message, ServerFrame } from "@ember/protocol";
import { initialRoomState, isPending, paged, resumed, roomReducer, typed, welcomed, type RoomAction, type RoomState } from "./room-state";

/**
 * A thread as its panel shows it: the message it's for, its parent, and its replies, a timeline of their
 * own, which the room's frames keep as they keep the room's.
 */
export interface ThreadState {
  parentId: string;
  /** The parent: undefined until the room has said, and null once it says it has no such message, or it goes. */
  parent: Message | null | undefined;
  replies: RoomState;
  /** The reply a permalink goes to, until the thread has gone there, paging back to it if it's older than its replies. */
  openingAt?: string;
}

/** What changes a thread: what changes a room's timeline, and going to a reply, as its permalink does. */
export type ThreadAction = RoomAction | { type: "open-at"; replyId: string };

/** A thread's replies keep everything they load: the thread only pages back, so its newest are always there. */
const NO_REPLIES: RoomState = { ...initialRoomState, keepsAll: true };

export const initialThreadState = ({ parentId, replyId }: { parentId: string; replyId?: string }): ThreadState => ({
  parentId,
  parent: undefined,
  replies: NO_REPLIES,
  openingAt: replyId,
});

const withBoosts = (message: Message, boosts: Boost[]): Message => ({ ...message, boosts });

/**
 * The replies a thread opened again shows. While the newest page holds every reply it showed, those caught
 * up with it, as a room's timeline is with what changed while it was away, and those it doesn't hold have
 * been deleted. Once they go back further, the page can't say what came, changed or went before it, so it
 * takes their place, as when the thread first opened, and paging back brings the older ones as they are.
 */
function reopened(replies: RoomState, { messages, hasMore }: Extract<ServerFrame, { type: "thread.opened" }>): RoomState {
  const shown = replies.messages.filter((m) => !isPending(m));
  if (hasMore && (shown.length === 0 || shown[0]!.id < messages[0]!.id)) return welcomed(replies, { messages, hasMore, hasNewer: false, around: null }, []);
  const kept = new Set(messages.map((m) => m.id));
  return resumed(replies, { messages, deletedIds: shown.flatMap((m) => (kept.has(m.id) ? [] : [m.id])) }, []);
}

/**
 * The thread going to the reply `openingAt` names once it has opened: there once it has it, or, while
 * that's older than every reply it has, still on its way, as useThread pages back, or else to its end.
 */
function opening(state: ThreadState): ThreadState {
  const { openingAt, replies, ...thread } = state;
  if (openingAt === undefined || replies.connections === 0) return state;
  const found = replies.messages.some((m) => !isPending(m) && m.id === openingAt);
  if (!found && replies.hasMore && replies.oldestId !== null && openingAt < replies.oldestId) return state;
  return { ...thread, replies: { ...replies, focus: { messageId: found ? openingAt : null } } };
}

/** Whether an error is about replies the thread is sending, which it shows as not sent. */
function isAboutSending(replies: RoomState, error: Extract<ServerFrame, { type: "error" }>): boolean {
  const ids = error.clientMessageIds ?? (error.clientMessageId === undefined ? [] : [error.clientMessageId]);
  return replies.messages.some((m) => isPending(m) && ids.includes(m.clientMessageId));
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  if (action.type === "reset") return initialThreadState({ parentId: state.parentId });
  if (action.type === "open-at") return opening({ ...state, openingAt: action.replyId });
  // Going to its end, the thread stops going to the reply a permalink named.
  if (action.type === "focus") return { parentId: state.parentId, parent: state.parent, replies: roomReducer(state.replies, action) };
  const withReplies = (replies: RoomState): ThreadState => (replies === state.replies ? state : { ...state, replies });
  if (action.type !== "frame") return withReplies(roomReducer(state.replies, action));
  const { frame } = action;
  const { parent, parentId } = state;
  switch (frame.type) {
    case "thread.opened": {
      if (frame.parentId !== parentId) return state;
      // The first time it opens, the thread goes to the reply its permalink names, or else to its end. Each
      // time after, as the room lets the page in again, the reader keeps their place, when the page can.
      if (state.replies.connections > 0) return opening({ ...state, parent: frame.parent, replies: reopened(state.replies, frame) });
      const page = { messages: frame.messages, hasMore: frame.hasMore, hasNewer: false, around: null };
      return opening({ ...state, parent: frame.parent, replies: welcomed(state.replies, page, []) });
    }
    case "thread.history":
      return frame.parentId === parentId ? opening(withReplies(paged(state.replies, frame))) : state;
    case "message.created":
      // A thread can be open before the room has written its message, as a huddle's is that shows it from its start.
      if (frame.message.id === parentId) return { ...state, parent: frame.message };
      return frame.message.parentId === parentId ? withReplies(roomReducer(state.replies, action)) : state;
    case "message.updated":
      return frame.message.id === parentId ? { ...state, parent: frame.message } : withReplies(roomReducer(state.replies, action));
    case "message.deleted":
      return frame.messageId === parentId ? { ...state, parent: null } : withReplies(roomReducer(state.replies, action));
    case "boost.created":
      return frame.boost.messageId === parentId && parent
        ? { ...state, parent: withBoosts(parent, [...parent.boosts, frame.boost]) }
        : withReplies(roomReducer(state.replies, action));
    case "boost.deleted":
      return frame.messageId === parentId && parent
        ? { ...state, parent: withBoosts(parent, parent.boosts.filter((b) => b.id !== frame.boostId)) }
        : withReplies(roomReducer(state.replies, action));
    case "message.checked":
      return withReplies(roomReducer(state.replies, action));
    case "typing":
      return frame.threadId === parentId ? withReplies({ ...state.replies, typing: typed(state.replies.typing, frame, action.now) }) : state;
    case "error": {
      const { replies } = state;
      // The room doesn't say which reaction it refused to delete, so a reaction shown as going in the thread
      // may be the one, and it comes back.
      if (frame.failed === "boost.delete") return withReplies({ ...replies, refusedUnboosts: replies.refusedUnboosts + 1 });
      if (frame.failed === "thread.open") return withReplies({ ...replies, notice: frame.message });
      // A failed page of replies leaves nothing in flight, so the reader can page again, though the thread
      // stops paging back to the reply a permalink goes to.
      if (frame.failed === "thread.before") return { parentId, parent, replies: { ...replies, notice: frame.message, loadingOlder: false } };
      return isAboutSending(replies, frame) ? withReplies(roomReducer(replies, action)) : state;
    }
    // The room's own pages, presence and typing in the room aren't the thread's. As the room lets the
    // page in again, useThread opens the thread again.
    default:
      return state;
  }
}

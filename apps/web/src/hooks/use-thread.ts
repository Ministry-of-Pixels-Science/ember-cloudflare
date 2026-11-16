import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import { HISTORY_PAGE_SIZE, MAX_CHECKED_MESSAGES, MESSAGE_TOO_LONG, type Message, type User } from "@ember/protocol";
import { writtenBody } from "@ember/richtext/dom";
import { handOver, leftUnsent, takeBack } from "@/lib/outbox";
import { isQueued, unconfirmed, type ConnectionStatus, type PendingMessage } from "@/lib/room-state";
import { initialThreadState, threadReducer } from "@/lib/thread-state";
import { UPLOAD_FAILED, UploadError, uploadFile } from "@/lib/uploads";
import { useLatestReducer } from "./use-latest-reducer";
import { isTooLong, messageActionsOf, pendingMessage, TYPING_TTL_MS, type RoomFrames } from "./use-room";

/**
 * A thread's live state, the message `parentId` names in `roomId` and its replies, over the room's socket,
 * `frames`, as `me`, whose connection to the room is `status`, and `offline` once it's been away a while.
 * `openedAt` is the reply whose permalink opened the thread, which it goes to as `jump` does. It asks the
 * room for the thread as it opens, and again each time the room lets the page in again, and tells the
 * room as it closes, so that its replies reach this person as pushes again. Replies it leaves unsent as
 * it closes, the outbox sends.
 */
export function useThread(roomId: string, frames: RoomFrames, status: ConnectionStatus, offline: boolean, me: User, parentId: string, openedAt?: string) {
  const [state, dispatch, latest] = useLatestReducer(threadReducer, () => initialThreadState({ parentId, replyId: openedAt }));
  const { send } = frames;
  const closed = useRef(false);
  // As the room's timeline takes back what was left unsent there, the thread takes back its replies.
  const takeBackUnsent = useEffectEvent(() => takeBack(roomId, me, parentId));

  // As useRoom asks about the messages a reconnect doesn't confirm, the thread asks about its replies,
  // once it has opened again.
  const checkUnconfirmed = useEffectEvent((snapshot: Message[]) => {
    const clientMessageIds = unconfirmed(state.replies.messages, snapshot).flatMap((m) => (m.failed || m.queued || (m.upload && !m.upload.error) ? [] : [m.clientMessageId]));
    for (let i = 0; i < clientMessageIds.length; i += MAX_CHECKED_MESSAGES) {
      send({ type: "message.check", clientMessageIds: clientMessageIds.slice(i, i + MAX_CHECKED_MESSAGES) });
    }
  });

  // Sends the replies written while the room was away, in the order they were written.
  const sendQueued = useEffectEvent(() => {
    const queued = state.replies.messages.filter(isQueued);
    if (queued.length === 0) return;
    for (const { clientMessageId, body, alsoSent } of queued) send({ type: "message.create", clientMessageId, body, parentId, alsoSend: alsoSent === true });
    dispatch({ type: "sent", clientMessageIds: queued.map((m) => m.clientMessageId) });
  });

  useEffect(() => {
    closed.current = false;
    const kept = takeBackUnsent();
    if (kept.length > 0) dispatch({ type: "kept", messages: kept });
    const open = () => send({ type: "thread.open", parentId });
    const stop = frames.listen((frame) => {
      dispatch({ type: "frame", frame, now: Date.now() });
      if (frame.type === "welcome" || frame.type === "resumed") open();
      if (frame.type === "thread.opened" && frame.parentId === parentId) {
        checkUnconfirmed(frame.messages);
        sendQueued();
      }
    });
    // Until the room lets the page in, its welcome opens the thread.
    open();
    return () => {
      closed.current = true;
      stop();
      send({ type: "thread.close", parentId });
      handOver(roomId, leftUnsent(latest.current.replies));
    };
  }, [frames, send, parentId]);

  // The thread is open once the room has sent it, and away whenever the room is.
  useEffect(() => {
    if (status !== "open") dispatch({ type: "status", status });
  }, [status]);
  useEffect(() => {
    if (offline !== state.replies.offline) dispatch({ type: "offline", offline });
  }, [offline, state.replies.offline]);

  // As the room's timeline does, the thread forgets typing it has stopped hearing of.
  useEffect(() => {
    const expire = setInterval(() => dispatch({ type: "expire-typing", before: Date.now() - TYPING_TTL_MS }), 1_000);
    return () => clearInterval(expire);
  }, []);

  const warn = useCallback((message: string) => dispatch({ type: "warn", message }), []);

  /** A reply `me` is writing, as the thread shows it until the room has it. */
  const pendingReply = useCallback(
    (clientMessageId: string, body: string, plainText: string, mentions: Message["mentions"], alsoSend: boolean): PendingMessage => ({
      ...pendingMessage(clientMessageId, roomId, me, body, plainText, mentions, new Date().toISOString()),
      parentId,
      alsoSent: alsoSend,
    }),
    [me, roomId, parentId],
  );

  // Answers whether the reply went, as useRoom's postMessage does.
  const postReply = useCallback(
    (body: string, alsoSend: boolean) => {
      const { plainText: text, mentions } = writtenBody(body);
      if (isTooLong(body, text)) {
        warn(MESSAGE_TOO_LONG);
        return false;
      }
      const reply = pendingReply(crypto.randomUUID(), body, text, mentions, alsoSend);
      if (!send({ type: "message.create", clientMessageId: reply.clientMessageId, body, parentId, alsoSend })) reply.queued = true;
      dispatch({ type: "pending", message: reply });
      return true;
    },
    [send, warn, pendingReply, parentId],
  );

  // Each file goes as a reply of its own, one at a time, as useRoom's postFiles sends them. Closing the
  // thread drops those whose upload hasn't started.
  const postFiles = useCallback(
    async (files: File[], alsoSend: boolean) => {
      for (const file of files) {
        if (closed.current) return;
        const clientMessageId = crypto.randomUUID();
        const upload = { name: file.name, size: file.size, percent: 0 };
        dispatch({ type: "pending", message: { ...pendingReply(clientMessageId, "", file.name, [], alsoSend), upload } });
        try {
          const thread = { parentId, alsoSend };
          const message = await uploadFile(roomId, file, clientMessageId, (percent) => dispatch({ type: "upload-progress", clientMessageId, percent }), thread);
          dispatch({ type: "uploaded", message });
        } catch (error) {
          dispatch({ type: "upload-failed", clientMessageId, error: error instanceof UploadError ? error.message : UPLOAD_FAILED });
          send({ type: "message.check", clientMessageIds: [clientMessageId] });
        }
      }
    },
    [roomId, parentId, send, pendingReply],
  );

  const loadOlder = useCallback(() => {
    const before = state.replies.oldestId;
    if (before === null || state.replies.loadingOlder) return;
    if (send({ type: "thread.before", parentId, before, limit: HISTORY_PAGE_SIZE })) dispatch({ type: "loading-older" });
  }, [send, parentId, state.replies.oldestId, state.replies.loadingOlder]);

  // While it goes to a reply older than those it has, the thread pages back to it, a page at a time.
  const { openingAt, replies } = state;
  const pagingBack = openingAt !== undefined && replies.status === "open" && replies.hasMore && !replies.loadingOlder;
  const pageBack = useEffectEvent(loadOlder);
  useEffect(() => {
    if (pagingBack) pageBack();
  }, [pagingBack]);

  /**
   * Goes to a reply, as its permalink does, paging back to it when it's older than the replies the thread
   * has, or to the thread's end when `replyId` is null, or the thread has no such reply.
   */
  const jump = useCallback((replyId: string | null) => dispatch(replyId === null ? { type: "focus", messageId: null } : { type: "open-at", replyId }), []);

  const messageActions = useMemo(() => messageActionsOf(frames, warn), [frames, warn]);
  const dismissNotice = useCallback(() => dispatch({ type: "dismiss-notice" }), []);

  return { state, postReply, postFiles, loadOlder, jump, messageActions, dismissNotice };
}

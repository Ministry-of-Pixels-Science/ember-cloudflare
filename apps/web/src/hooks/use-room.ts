import { createContext, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CloseCode,
  HISTORY_PAGE_SIZE,
  isInRoom,
  isMessageTooLong,
  MAX_CHECKED_MESSAGES,
  MAX_MESSAGE_HTML_LENGTH,
  MESSAGE_TOO_LONG,
  parseServerFrame,
  workspacePageOf,
  type ClientFrame,
  type Me,
  type Message,
  type ServerFrame,
  type User,
} from "@ember/protocol";
import { writtenBody } from "@ember/richtext/dom";
import type { MessageActions } from "@/components/workspace/message-item";
import { ApiError, fetchMe, roomSocketUrl } from "@/lib/api";
import { handOver, leftUnsent, takeBack } from "@/lib/outbox";
import { openAhead, reconnectingSocket, waitingAhead, type ReconnectingSocket } from "@/lib/reconnecting-socket";
import { initialRoomState, isPending, isQueued, roomReducer, unconfirmed, type PendingMessage } from "@/lib/room-state";
import { UPLOAD_FAILED, UploadError, uploadFile } from "@/lib/uploads";
import { settledVisibility } from "@/lib/visibility";
import { useLatestReducer } from "./use-latest-reducer";

/** How long someone shows as typing after the room last heard them start, as Campfire's typing_tracker.js keeps them. */
export const TYPING_TTL_MS = 5_000;
/** How often typing tells the room, as Campfire's typing_notifications_controller.js throttles it. */
const TYPING_THROTTLE_MS = 1_000;

/**
 * How many times the room has let the page in (`RoomState.connections`), for what shows a change as
 * made before the room confirms it: once the page reconnects, the room may never have had it.
 */
export const RoomConnection = createContext(0);

/**
 * How many times the room has refused to delete a reaction (`RoomState.refusedUnboosts`), for a reaction
 * shown as going before the room deletes it: once the room refuses one, it may have been that one.
 */
export const RefusedUnboosts = createContext(0);

/**
 * Whether the room would refuse `body`, whose plain text is `text`, as too long: more text than it
 * takes, or more markup than a frame carries, which only so much formatting makes.
 */
export const isTooLong = (body: string, text: string) => isMessageTooLong(text) || body.length > MAX_MESSAGE_HTML_LENGTH;

/** What a room's socket carries, for what shows a part of the room apart from its timeline, as a thread. */
export interface RoomFrames {
  /** Sends `frame` to the room, answering whether it went, which it doesn't while the room is away. */
  send: (frame: ClientFrame) => boolean;
  /** Hears each frame the room sends, after the room's timeline has, until the function it answers is called. */
  listen: (listener: (frame: ServerFrame) => void) => () => void;
}

/**
 * What can be done to a room's messages over `frames`. Unlike new messages, these aren't kept to send later,
 * so `warn` says when one couldn't go. An edit longer than the room takes isn't sent either, so its editor
 * keeps it.
 */
export function messageActionsOf({ send, listen }: RoomFrames, warn: (message: string) => void): MessageActions {
  const sendOrWarn = (frame: ClientFrame) => {
    const sent = send(frame);
    if (!sent) warn("Not connected. Try again once you're reconnected.");
    return sent;
  };
  return {
    edit: (messageId, body) => {
      if (!isTooLong(body, writtenBody(body).plainText)) return sendOrWarn({ type: "message.update", messageId, body });
      warn(MESSAGE_TOO_LONG);
      return false;
    },
    remove: (messageId) => sendOrWarn({ type: "message.delete", messageId }),
    boost: (messageId, content) => sendOrWarn({ type: "boost.create", messageId, content }),
    unboost: (boostId) => sendOrWarn({ type: "boost.delete", boostId }),
    click: (messageId, { id: actionId, blockId, value }) => {
      const clickId = crypto.randomUUID();
      const button = { actionId, ...(blockId !== undefined && { blockId }), ...(value !== undefined && { value }) };
      if (!sendOrWarn({ type: "card.click", clickId, messageId, ...button })) return Promise.resolve(false);
      return new Promise((resolve) => {
        const answered = (went: boolean) => {
          stop();
          resolve(went);
        };
        // The room answers once the bot has, or says why it didn't, which the timeline shows. A room that
        // lets the page in again has lost the click's answer, if not the click.
        const stop = listen((frame) => {
          if (frame.type === "card.clicked" && frame.clickId === clickId) answered(true);
          else if (frame.type === "error" && frame.clickId === clickId) answered(false);
          else if (frame.type === "welcome" || frame.type === "resumed") answered(false);
        });
      });
    },
  };
}

/**
 * The address a room's socket is opened at ahead of the room: a hidden tab's, so that the room reads nothing
 * for it, nor counts its person as there to see what's said, until it shows and says whether the tab is shown.
 */
const aheadUrl = (roomId: string, around?: string) => roomSocketUrl(roomId, { visible: false, around });

/**
 * Opens the socket of the room the page at `pathname` shows, if it shows one, ahead of the room, which
 * takes it once it shows, so that the room's newest messages are on their way while the workspace loads.
 * Returns what closes it, unless the room has taken it.
 */
export function openRoomSocketAhead(pathname: string): () => void {
  const route = workspacePageOf(pathname);
  if (route?.page !== "room") return () => {};
  return openAhead(aheadUrl(route.roomId, route.messageId));
}

/**
 * One room's live state over a reconnecting WebSocket to its ChatRoom Durable Object, as `me`.
 * `onSessionChanged` hears when the browser's session stops signing in `me`: null once it has expired,
 * or whoever another tab signed in as. `openedAt` is the message whose permalink opened the room, which
 * the timeline starts around.
 */
export function useRoom(roomId: string, me: User, onSessionChanged: (me: Me | null) => void, openedAt?: string) {
  const [state, dispatch, latest] = useLatestReducer(roomReducer, () => initialRoomState);
  const [around] = useState(openedAt);
  const socket = useRef<ReconnectingSocket | null>(null);
  const listeners = useRef(new Set<(frame: ServerFrame) => void>());
  const lastTypingStarted = useRef(-Infinity);
  const sessionChanged = useEffectEvent(onSessionChanged);
  const isSomeoneElse = useEffectEvent((user: User) => user.id !== me.id);
  // What this page left unsent here when the room was last left waits in the timeline again, to go, or
  // show as not sent, as it would have had the room stayed open.
  const takeBackUnsent = useEffectEvent(() => takeBack(roomId, me));

  // A message sent over the socket can lose its answer, where one posted over HTTP fails only when the
  // request does: the socket can close after the room stored a message but before the confirmation came
  // back, and a reconnect's welcome only holds the newest page, which a later `resumed` doesn't go back
  // past. So ask the room about the sent messages a reconnect doesn't confirm, which the reducer keeps
  // as sending until it answers. Those written while it was away never went, so they aren't asked about,
  // and nor are files on their way, whose uploads answer for them. A failed upload is, since its answer
  // can be lost after the room posted it.
  const checkUnconfirmed = useEffectEvent((room: ReconnectingSocket, snapshot: Message[]) => {
    const clientMessageIds = unconfirmed(state.messages, snapshot).flatMap((m) => (m.failed || m.queued || (m.upload && !m.upload.error) ? [] : [m.clientMessageId]));
    for (let i = 0; i < clientMessageIds.length; i += MAX_CHECKED_MESSAGES) {
      room.send({ type: "message.check", clientMessageIds: clientMessageIds.slice(i, i + MAX_CHECKED_MESSAGES) });
    }
  });

  // Sends the messages written while the room was away, in the order they were written, at the end of a
  // timeline that holds the newest page, which one reading older history asks for first. The frame that
  // let the page in isn't in `state` yet, and a welcome brings a timeline of its own, such as the older
  // page a permalink opens.
  const sendQueued = useEffectEvent((room: ReconnectingSocket, opening: Extract<ServerFrame, { type: "welcome" | "resumed" }>) => {
    const queued = state.messages.filter(isQueued);
    if (queued.length === 0) return;
    const hasNewer = opening.type === "welcome" ? opening.hasNewer : state.hasNewer;
    if (hasNewer && room.send({ type: "history.around" })) dispatch({ type: "loading-page" });
    for (const { clientMessageId, body } of queued) room.send({ type: "message.create", clientMessageId, body });
    dispatch({ type: "sent", clientMessageIds: queued.map((m) => m.clientMessageId) });
  });

  useEffect(() => {
    let closed = false;
    // The latest change to the room this page has heard of, by its number, which a socket that connects
    // again names, so the room sends what changed since rather than its newest page. The room numbers its
    // changes one after another, so a gap is one it never announced, as when D1 saves a batch whose answer
    // is lost: this stays at the change before it, and connecting again brings what it missed.
    let seen: number | undefined;
    // The permalink's message, until the room has opened the timeline: a socket that connects again keeps it as it is.
    let openingAround = around;

    // Tells the room when the tab has been shown or hidden for a while, unless its socket's address or an
    // earlier frame said so already. Until the room lets the socket in, the welcome tells it.
    let told: boolean;
    const tellVisibility = (visible: boolean) => {
      if (visible !== told && room.send({ type: "presence.visible", visible })) told = visible;
    };
    const visibility = settledVisibility(tellVisibility);

    // Asks who this browser is signed in as now and hands over to them, or to sign in, unless it's still
    // this person or it can't tell, when it does `then`. A session check that answers once this room
    // has closed is dropped: by then it may be about a session that has since been replaced.
    const unlessSessionChanged = (then: () => void) => {
      dispatch({ type: "status", status: "reconnecting" });
      void fetchMe().then(
        (user) => !closed && (isSomeoneElse(user) ? sessionChanged(user) : then()),
        (error) => !closed && (error instanceof ApiError && error.status === 401 ? sessionChanged(null) : then()),
      );
    };

    const onMessage = (data: string) => {
      const frame = parseServerFrame(data);
      if (!frame) return;
      const opening = frame.type === "welcome" || frame.type === "resumed";
      if (opening && isSomeoneElse(frame.you)) {
        // Another tab signed this browser out and in as someone else, and the cookie went with it. Leave
        // the room rather than show them this person's, or send as them, and hand over to whoever the
        // server says is signed in, which the room only partly knows: by then it may be this person again.
        room.hold();
        unlessSessionChanged(() => room.retry());
        return;
      }
      // A room from before rooms numbered their changes opens without a number, which leaves none to name.
      if (opening) seen = frame.seq;
      else if ("seq" in frame && seen !== undefined && frame.seq === seen + 1) seen = frame.seq;
      if (opening) openingAround = undefined;
      // A reply sent only to its thread is the thread's, not the timeline's.
      if (frame.type !== "message.created" || isInRoom(frame.message)) dispatch({ type: "frame", frame, now: Date.now() });
      if (opening) {
        room.connected();
        tellVisibility(visibility.visible);
        checkUnconfirmed(room, frame.messages);
        sendQueued(room, frame);
      }
      for (const listener of listeners.current) listener(frame);
    };

    const onClose = (code: number, opened: boolean) => {
      // The person lost access for good, removed from the workspace or banned, which ends all their
      // sessions, so they connect again only if the browser is still signed in as them.
      if (code === CloseCode.Revoked) {
        unlessSessionChanged(() => room.retry());
        return false;
      }
      // The room isn't there for whoever the browser is signed in as: deleted, or no longer theirs. If
      // that's still this person, there's nothing to connect to.
      if (code === CloseCode.NotFound) {
        unlessSessionChanged(() => {
          room.close();
          dispatch({ type: "status", status: "gone" });
        });
        return false;
      }
      // A refused upgrade looks like any other failure, so ask whether the session has expired, as
      // when the room says to reconnect, which it does when this browser signs out.
      if (!opened || code === CloseCode.Reconnect) {
        void fetchMe().catch((error) => !closed && error instanceof ApiError && error.status === 401 && sessionChanged(null));
      }
      return true;
    };

    dispatch({ type: "reset" });
    const kept = takeBackUnsent();
    if (kept.length > 0) dispatch({ type: "kept", messages: kept });
    const room = reconnectingSocket({
      url: () => {
        // The room's first socket is the one opened ahead of it, if one is waiting: a hidden tab's, which the
        // welcome then tells whether the tab is shown.
        const ahead = aheadUrl(roomId, openingAround);
        if (seen === undefined && waitingAhead(ahead)) {
          told = false;
          return ahead;
        }
        return roomSocketUrl(roomId, { visible: (told = visibility.visible), since: seen, around: openingAround });
      },
      onMessage,
      onConnecting: (status) => dispatch({ type: "status", status }),
      onOffline: (offline) => dispatch({ type: "offline", offline }),
      onClose,
    });
    socket.current = room;

    const expire = setInterval(() => dispatch({ type: "expire-typing", before: Date.now() - TYPING_TTL_MS }), 1_000);
    return () => {
      closed = true;
      clearInterval(expire);
      visibility.stop();
      room.close();
      socket.current = null;
      // Leaving the room loses none of what was written here: the outbox sends what hasn't gone.
      handOver(roomId, leftUnsent(latest.current));
    };
  }, [roomId, around]);

  const send = useCallback((frame: ClientFrame) => socket.current?.send(frame) ?? false, []);
  const frames = useMemo<RoomFrames>(
    () => ({
      send,
      listen: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [send],
  );
  // Says why something written didn't go, as the room says why it refused something.
  const warn = useCallback((message: string) => dispatch({ type: "warn", message }), []);

  // Whether the timeline is reading older history, or on its way back from it. Files go one after another,
  // each long after the page that sent them rendered, so this is the timeline as it is now.
  const awayFromNewest = useRef(false);
  useLayoutEffect(() => {
    awayFromNewest.current = state.hasNewer || state.loadingPage;
  }, [state.hasNewer, state.loadingPage]);

  // A message sent goes at the end of the newest page, which a timeline reading older history asks for
  // first, as Campfire's insertPendingMessage does.
  const toNewest = useCallback(() => {
    if (awayFromNewest.current && send({ type: "history.around" })) dispatch({ type: "loading-page" });
  }, [send]);

  // Answers whether the message went. One longer than the room takes doesn't, and stays where it was written.
  const postMessage = useCallback(
    (body: string) => {
      const { plainText: text, mentions } = writtenBody(body);
      if (isTooLong(body, text)) {
        warn(MESSAGE_TOO_LONG);
        return false;
      }
      const message = pendingMessage(crypto.randomUUID(), roomId, me, body, text, mentions, new Date().toISOString());
      toNewest();
      // Until the room has let a connection in, it waits, behind any already waiting, and shows as not
      // sent once the page is offline.
      if (!send({ type: "message.create", clientMessageId: message.clientMessageId, body })) message.queued = true;
      dispatch({ type: "pending", message });
      return true;
    },
    [me, roomId, send, warn, toNewest],
  );

  // As Campfire's composer_controller.js#submitFiles sends them, each file goes as a message of its own,
  // one at a time, its card showing how its upload goes until the room posts it. Leaving the room drops
  // those whose upload hasn't started. The room is asked about one that fails, as it may have posted the
  // file before the answer was lost; a reconnect asks, if the socket's down.
  const postFiles = useCallback(
    async (files: File[]) => {
      const room = socket.current;
      for (const file of files) {
        if (socket.current !== room) return;
        const clientMessageId = crypto.randomUUID();
        const now = new Date().toISOString();
        const upload = { name: file.name, size: file.size, percent: 0 };
        toNewest();
        dispatch({ type: "pending", message: { ...pendingMessage(clientMessageId, roomId, me, "", file.name, [], now), upload } });
        try {
          const message = await uploadFile(roomId, file, clientMessageId, (percent) => dispatch({ type: "upload-progress", clientMessageId, percent }));
          dispatch({ type: "uploaded", message });
        } catch (error) {
          dispatch({ type: "upload-failed", clientMessageId, error: error instanceof UploadError ? error.message : UPLOAD_FAILED });
          room?.send({ type: "message.check", clientMessageIds: [clientMessageId] });
        }
      }
    },
    [me, roomId, toNewest],
  );

  // Starting is throttled, and stopping isn't, as in Campfire: a start within a second of the last one
  // goes nowhere, even after a stop. A sent message needs no stop, since everyone else stops showing its
  // author as typing when it arrives.
  const typing = useCallback(
    (active: boolean) => {
      if (!active) return void send({ type: "typing.stop" });
      const now = Date.now();
      if (now - lastTypingStarted.current < TYPING_THROTTLE_MS) return;
      lastTypingStarted.current = now;
      send({ type: "typing.start" });
    },
    [send],
  );

  // A page asked for while another takes the timeline's place would page from the timeline being replaced.
  const loadOlder = useCallback(() => {
    const before = state.oldestId;
    if (before === null || state.loadingOlder || state.loadingPage) return;
    if (send({ type: "history.before", before, limit: HISTORY_PAGE_SIZE })) dispatch({ type: "loading-older" });
  }, [send, state.oldestId, state.loadingOlder, state.loadingPage]);

  const loadNewer = useCallback(() => {
    const after = state.newestId;
    if (after === null || !state.hasNewer || state.loadingNewer || state.loadingPage) return;
    if (send({ type: "history.after", after, limit: HISTORY_PAGE_SIZE })) dispatch({ type: "loading-newer" });
  }, [send, state.newestId, state.hasNewer, state.loadingNewer, state.loadingPage]);

  /**
   * Goes to a message, as its permalink does, or to the newest when `messageId` is null, as Jump to newest
   * message does: in the timeline, when it holds them, or else on the page the room sends around them.
   * Answers whether it went, which it can't while the room is away and the timeline doesn't hold them.
   */
  const jump = useCallback(
    (messageId: string | null) => {
      const holds = messageId === null ? !state.hasNewer : state.messages.some((m) => !isPending(m) && m.id === messageId);
      if (holds && !state.loadingPage) dispatch({ type: "focus", messageId });
      else if (send({ type: "history.around", messageId: messageId ?? undefined })) dispatch({ type: "loading-page" });
      else return false;
      return true;
    },
    [send, state.messages, state.hasNewer, state.loadingPage],
  );

  const messageActions = useMemo(() => messageActionsOf(frames, warn), [frames, warn]);

  const dismissNotice = useCallback(() => dispatch({ type: "dismiss-notice" }), []);

  return { state, frames, postMessage, postFiles, typing, loadOlder, loadNewer, jump, messageActions, dismissNotice };
}

/** A message `me` is sending to `roomId` as `clientMessageId`, as the timeline shows it until the room has it. */
export function pendingMessage(
  clientMessageId: string,
  roomId: string,
  me: User,
  body: string,
  plainText: string,
  mentions: Message["mentions"],
  now: string,
): PendingMessage {
  return {
    id: clientMessageId,
    clientMessageId,
    roomId,
    creator: me,
    body,
    plainText,
    mentions,
    createdAt: now,
    updatedAt: now,
    editedAt: null,
    boosts: [],
    pending: true,
  };
}

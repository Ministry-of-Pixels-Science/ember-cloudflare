import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState } from "react";
import { CloseCode, parseServerFrame, type Account, type DirectoryUser, type Me, type RoomId, type User, type UserId, type WorkspaceClientFrame, type WorkspaceServerFrame } from "@ember/protocol";
import { fetchMe, fetchSidebar, isSignedOut, workspaceSocketUrl, type SidebarCopy } from "@/lib/api";
import type { InvitationsChange } from "@/lib/huddle-invitations";
import { reconnectingSocket } from "@/lib/reconnecting-socket";
import { NO_ROOM_LIST, roomListReducer, type RoomAnswer } from "@/lib/room-list";

/**
 * How long a tab is hidden before showing it loads the sidebar again, as Campfire's
 * refresh_room_controller.js waits (`REFRESH_AFTER_HIDDEN_TIMEOUT`).
 */
export const RELOAD_AFTER_HIDDEN_MS = 60_000;

/**
 * After a deploy, the workspace socket waits 2 to 10 seconds to connect again, where a room's waits a
 * quarter of a second to two. Each tab's room socket then comes back first, as the page shown needs,
 * and the Workspace, which every tab's sockets and sidebar ask, gets its calls spread over longer: with
 * a thousand tabs, `pnpm perf`'s tabs scenario found the rooms back as fast as without this socket.
 */
const DEPLOY_SPREAD_MS = [2_000, 10_000] as const;

/**
 * How long, at most, a tab waits to load its sidebar again once an administrator has put the rooms in
 * order for everyone, each tab waiting a while at random, so that every tab in the workspace doesn't ask
 * the Workspace at once.
 */
export const RELOAD_SPREAD_MS = 5_000;

/**
 * `task`, one run at a time. Called while it runs, it runs again once that run is over, once for all
 * the calls made meanwhile, since the run under way started before them. Each call settles as the first
 * run to start after it does.
 */
export function oneAtATime(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const run = () => (running = task().finally(() => (running = null)));
  return () => {
    if (next) return next;
    if (!running) return run();
    next = running
      .catch(() => {})
      .then(() => {
        next = null;
        return run();
      });
    return next;
  };
}

/** The people directory, as far as the workspace socket keeps it current. */
interface Directory {
  /** Everyone in it, as it lists them now. */
  people: ReadonlyMap<UserId, DirectoryUser>;
  /** Loads it again, as the sidebar does by itself, settling once it has or failed. */
  reload: () => Promise<void>;
  /** Changes someone in it, as the socket says they are now. */
  update: (user: DirectoryUser) => void;
  /** Takes someone out of it, once the socket says this person is no longer told of them. */
  remove: (userId: UserId) => void;
}

const NO_DIRECTORY: Directory = { people: new Map(), reload: async () => {}, update: () => {}, remove: () => {} };

/** Whether `you` and `me` are the same person, as they are now. */
const isSame = (you: Me, me: Me) => you.id === me.id && you.name === me.name && you.administrator === me.administrator;

/**
 * Someone's sidebar, which loads again each time the tab's workspace socket connects, the first time
 * included, as Campfire's rooms_list_controller.js reloads its frame, since nothing that changed while
 * it wasn't connected reached it. Meanwhile the socket brings rooms as they're made, changed and
 * deleted, and as this person is put in them and taken out, marks rooms unread and read, moves DMs as
 * messages come in them, and brings the stars saved in any of their tabs, and the welcome card dismissed
 * in any of them. It loads again when the tab is shown after more than a minute hidden too, as
 * `refresh-room:visible` reloads it (Campfire's users/sidebar_helper.rb), which Campfire does on a
 * room's page and this does on every page, and, its rooms only, a while after the socket says the shared
 * order has changed. Once it says this person has been given another role, it loads again with the
 * people directory, which lists administrators more. It loads again at once after a list that may have
 * a room in the wrong place, one this person was taken out of and put back in while the list was on its
 * way. `refresh` asks for it again, settling once a list asked for since has come, or failing as that
 * did.
 *
 * `onSessionChanged` hears when who the browser's session signs in changes: null once it has expired,
 * whoever another tab signed in as, or `me` as they are now, once they've been made an administrator,
 * say. The people `directory` loads again each time the sidebar does by itself, and hears whoever the
 * socket says has changed, or says this person is no longer told of, as an AI agent kept to
 * administrators' direct messages is. `onAccountChanged` hears the workspace as the socket says it is,
 * each time it connects and whenever an administrator changes it. `onGone` hears of each room the
 * socket says is gone as it leaves the list. `onInvitation` hears of each invitation into a huddle the
 * socket brings this person, and of each that's over: one they've answered, in this tab or another,
 * and one into a room the socket says is gone.
 */
export function useSidebar(
  me: Me,
  onSessionChanged: (me: Me | null) => void,
  directory: Directory = NO_DIRECTORY,
  onAccountChanged: (account: Account) => void = () => {},
  onGone: (roomId: RoomId) => void = () => {},
  onInvitation: (change: InvitationsChange) => void = () => {},
) {
  const [{ list, askAgain }, change] = useReducer(roomListReducer, NO_ROOM_LIST);
  // Whether a list the server sent has come, rather than only the empty one a failed first load leaves.
  const [answered, setAnswered] = useState(false);
  // How many of the workspace socket's frames have said what became of a room or of this person's level
  // in it, and the number of the last to speak of each room.
  const roomFrames = useRef({ count: 0, lastOf: new Map<RoomId, number>() });
  const [refresh] = useState(() => {
    // The last list the server sent, which it says is still current rather than send again.
    let copy: SidebarCopy | null = null;
    return oneAtATime(async () => {
      change({ type: "asked" });
      try {
        copy = await fetchSidebar(copy);
        change({ type: "loaded", list: copy.sidebar });
        setAnswered(true);
      } catch (error) {
        change({ type: "unanswered" });
        throw error;
      }
    });
  });
  // A list that doesn't come leaves the sidebar as it is, until it loads again.
  useEffect(() => {
    if (askAgain) void refresh().catch(() => {});
  }, [askAgain, refresh]);
  const sessionChanged = useEffectEvent(onSessionChanged);
  const accountChanged = useEffectEvent(onAccountChanged);
  // A failed load leaves the avatars as they are until the next.
  const reloadPeople = useEffectEvent(() => void directory.reload().catch(() => {}));
  const gone = useEffectEvent(onGone);
  const invitation = useEffectEvent(onInvitation);
  const isSomeoneElse = useEffectEvent((user: User) => user.id !== me.id);
  // Who the session signs in as last heard, ahead of `me` until the page takes the change: two changes
  // can come before it takes the first.
  const heard = useRef(me);
  useLayoutEffect(() => {
    heard.current = me;
  }, [me]);
  // Who the session signs in, as the socket says each time it connects and whenever they change.
  const signsIn = useEffectEvent((you: Me) => {
    if (isSame(you, heard.current)) return;
    heard.current = you;
    sessionChanged(you);
  });
  const changed = useEffectEvent((user: DirectoryUser) => {
    directory.update(user);
    if (user.id === me.id) signsIn({ id: user.id, name: user.name, administrator: user.role === "administrator" });
  });
  const hidden = useEffectEvent((userId: UserId) => directory.remove(userId));

  useEffect(() => {
    let closed = false;
    // A session that has expired goes to sign in. Otherwise a list that doesn't come leaves the sidebar
    // as it is, until it loads again.
    const reloadRooms = () => void refresh().catch((error) => !closed && isSignedOut(error) && sessionChanged(null));
    // The load the shared order waits for, which loading everything again makes needless.
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(waiting);
      waiting = undefined;
      reloadPeople();
      reloadRooms();
    };
    const reloadRoomsSoon = () => {
      waiting ??= setTimeout(() => {
        waiting = undefined;
        reloadRooms();
      }, Math.random() * RELOAD_SPREAD_MS);
    };

    // What this connection has said changed, the person signed in or the workspace, which can come
    // before its welcome. The welcome may have read it before that change, so it doesn't undo it. Each
    // try starts afresh, after a close or a socket that stopped answering alike.
    let toldOf = { you: false, account: false };
    const onConnecting = () => void (toldOf = { you: false, account: false });

    // Tells the Workspace whether the tab is shown, unless its socket's address or an earlier frame said
    // so already, since an invitation into a huddle is pushed to whoever has Ember in view nowhere. It's
    // told as that changes, where a room hears once the change has lasted: a phone can stop a tab soon
    // after hiding it. Until the Workspace lets the socket in, the welcome tells it.
    const shown = () => document.visibilityState === "visible";
    let told: boolean;
    const tellVisibility = () => {
      const visible = shown();
      if (visible !== told && workspace.send({ type: "presence.visible", visible })) told = visible;
    };

    const heardOf = (roomId: RoomId) => roomFrames.current.lastOf.set(roomId, ++roomFrames.current.count);
    const onMessage = (data: string) => {
      const frame = parseServerFrame<WorkspaceServerFrame>(data);
      switch (frame?.type) {
        case "welcome":
          if (isSomeoneElse(frame.you)) {
            // Another tab signed this browser out and in as someone else, and the cookie went with it.
            workspace.close();
            return sessionChanged(frame.you);
          }
          workspace.connected();
          tellVisibility();
          if (!toldOf.you) signsIn(frame.you);
          if (!toldOf.account) accountChanged(frame.account);
          return reload();
        case "room.saved":
          heardOf(frame.room.id);
          return change({ type: "saved", room: frame.room });
        case "room.gone":
          heardOf(frame.roomId);
          gone(frame.roomId);
          // An invitation into its huddle goes with it, though this tab's rooms never had the room.
          invitation({ type: "over", roomId: frame.roomId });
          return change({ type: "gone", roomId: frame.roomId });
        case "room.unread":
          return change({ type: "marked", roomId: frame.roomId, at: frame.at });
        case "room.read":
          return change({ type: "marked", roomId: frame.roomId, at: null });
        case "room.active":
          return change({ type: "active", roomId: frame.roomId, at: frame.at });
        case "room.huddle":
          return change({ type: "huddle", roomId: frame.roomId, huddle: frame.huddle });
        case "huddle.invited":
          return invitation({ type: "invited", roomId: frame.roomId, by: frame.by, at: Date.now() });
        case "huddle.answered":
          return invitation({ type: "over", roomId: frame.roomId });
        case "user.updated":
          if (!isSomeoneElse(frame.user)) {
            toldOf.you = true;
            // Only administrators are given the welcome card with their rooms, and told of the AI agents
            // only their direct messages reach, so a new role loads the rooms and the people again.
            if ((frame.user.role === "administrator") !== heard.current.administrator) reload();
          }
          return changed(frame.user);
        case "user.gone":
          return hidden(frame.userId);
        case "room.involvement":
          heardOf(frame.roomId);
          return change({ type: "involved", roomId: frame.roomId, involvement: frame.involvement });
        case "favorites.changed":
          return change({ type: "starred", favorites: frame.favorites });
        case "invitation.dismissed":
          return change({ type: "invitation dismissed" });
        case "rooms.reordered":
          return reloadRoomsSoon();
        case "account.updated":
          toldOf.account = true;
          return accountChanged(frame.account);
      }
    };

    // A refused upgrade looks like any other failure, so ask whether the session has expired, as when
    // the Workspace says to reconnect, which it does when this browser signs out. When the person loses
    // access for good, removed from the workspace or banned, which ends all their sessions, this
    // connects again only if the browser is still signed in as them, as a room's socket does.
    const onClose = (code: number, opened: boolean) => {
      if (code === CloseCode.Revoked) {
        void fetchMe().then(
          (user) => !closed && (isSomeoneElse(user) ? sessionChanged(user) : workspace.retry()),
          (error) => !closed && (isSignedOut(error) ? sessionChanged(null) : workspace.retry()),
        );
        return false;
      }
      if (!opened || code === CloseCode.Reconnect) void fetchMe().catch((error) => !closed && isSignedOut(error) && sessionChanged(null));
      return true;
    };

    // Unlike Campfire's, a page that loads hidden has been hidden since it loaded.
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt > RELOAD_AFTER_HIDDEN_MS) reload();
      hiddenAt = null;
    };

    reload();
    const workspace = reconnectingSocket<WorkspaceClientFrame>({
      url: () => workspaceSocketUrl({ visible: (told = shown()) }),
      onMessage,
      onConnecting,
      onClose,
      deploySpreadMs: DEPLOY_SPREAD_MS,
    });
    document.addEventListener("visibilitychange", visibilityChanged);
    document.addEventListener("visibilitychange", tellVisibility);
    return () => {
      closed = true;
      clearTimeout(waiting);
      workspace.close();
      document.removeEventListener("visibilitychange", visibilityChanged);
      document.removeEventListener("visibilitychange", tellVisibility);
    };
  }, [refresh]);

  /**
   * Called as a room is saved or deleted, or this person's level in it: what lists it as the server
   * answers, unless the workspace socket has said what became of the room or the level since, which the
   * answer could undo, as with a rename or a level saved in another tab just after. The socket brings
   * this change too, in its turn, if it changed anything.
   */
  const askForRoom = useCallback(() => {
    const asked = roomFrames.current.count;
    return (answer: RoomAnswer) => {
      const roomId = answer.type === "saved" ? answer.room.id : answer.roomId;
      if ((roomFrames.current.lastOf.get(roomId) ?? 0) <= asked) change(answer);
    };
  }, []);

  return { list, answered, change, refresh, askForRoom };
}

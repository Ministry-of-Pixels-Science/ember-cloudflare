import { useEffect, useEffectEvent, useImperativeHandle, useRef, type Ref } from "react";
import type { Favorites, Invitation, Involvement, Me, User } from "@ember/protocol";
import { MainContent } from "@/components/main-content";
import { useNameOf } from "@/hooks/use-directory";
import { useGivingBack } from "@/hooks/use-giving-back";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMessageEditors } from "@/hooks/use-message-editors";
import { useRoom } from "@/hooks/use-room";
import { useVisit } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import type { Room } from "@/lib/api";
import { roomName } from "@/lib/directs";
import { rememberLastRoom } from "@/lib/last-room";
import { newestWrittenBy } from "@/lib/messages";
import type { RoomAnswer } from "@/lib/room-list";
import { isPending } from "@/lib/room-state";
import { Composer, RoomDeleted, type ComposerHandle } from "./composer";
import { MessageList } from "./message-list";
import { RoomHeader } from "./room-header";
import { RoomNotice } from "./room-notice";
import { ThreadPanel } from "./thread-panel";

/** Where a thread covers its room, rather than showing beside it: below 1180px wide. */
const THREAD_COVERS_ROOM = "(width < 73.75rem)";

/** Who joined the workspace, and when, in a DM started as they did, which its timeline opens with, or null. */
function joinedIn(room: Room): { user: User; at: string } | null {
  if (room.kind !== "direct" || !room.joined) return null;
  const { userId, at } = room.joined;
  const user = room.members.find((member) => member.id === userId);
  return user ? { user, at } : null;
}

interface Props {
  room: Room;
  /** The message whose permalink the address is, which the timeline goes to. */
  messageId?: string;
  /** The message whose thread the address opens beside the room. */
  threadId?: string;
  /** The reply whose permalink the address is, which the thread goes to. */
  replyId?: string;
  /** The welcome card's invitation, when this is the room it's in. */
  invitation: Invitation | null;
  /** Dismisses the welcome card for good, settling once it's gone, or failed to go. */
  onDismissInvitation: () => Promise<void>;
  me: Me;
  /** Whether this person has starred the room. */
  favorite: boolean;
  /** Whether the workspace socket has said the room is gone for this person, as it can before the room's own socket does. */
  gone: boolean;
  /** Called with this person's stars once the room's star saves them. */
  onStarred: (favorites: Favorites) => void;
  /** This person's notification level in the room. */
  involvement: Involvement;
  /** When the room was marked unread as of when it was opened, which the timeline draws a New line at, or null. */
  newSince?: string | null;
  /** Called as its bell saves this person's level in the room, with what gives the room the level the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  onSessionChanged: (me: Me | null) => void;
  /** Says why the room's bell couldn't save a level, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
  /** When the room turns out to be gone for this person: deleted, or no longer theirs. */
  onGone: (room: Room) => void;
  ref?: Ref<RoomViewHandle>;
}

export interface RoomViewHandle {
  /** Gives the composer focus, as opening the room does, except on touch screens. */
  focusComposer(): void;
}

export function RoomView({ room, messageId, threadId, replyId, invitation, onDismissInvitation, me, favorite, gone, onStarred, involvement, newSince = null, askForRoom, onSessionChanged, onFailed, onGone, ref }: Props) {
  const { state, frames, postMessage, postFiles, typing, loadOlder, loadNewer, jump, messageActions, dismissNotice, givenBack } = useRoom(room.id, me, onSessionChanged, messageId);
  const nameOf = useNameOf();
  const name = roomName(room, me.id, nameOf);
  const direct = room.kind === "direct";
  useTitle(name);
  // The room shown is remembered, for home and Go Back to return to.
  useEffect(() => rememberLastRoom(room.id), [room.id]);
  const foundGone = state.status === "gone";
  const roomGone = useEffectEvent(() => onGone(room));
  useEffect(() => {
    if (foundGone) roomGone();
  }, [foundGone]);
  const deleted = gone || foundGone;

  // The room opens at the message its address names. Following its permalink, or one to another message
  // in it, or the room's own link, goes there, or to the newest, even when it's the page shown. One
  // followed while the room is away goes there once the room lets the page in again. Opening a thread,
  // even at a permalink, whose address the thread's takes the place of, going to one of its replies, or
  // closing it leaves the room's messages as they are.
  const visit = useVisit();
  const visited = useRef({ messageId, visit, threadId });
  const goTo = useEffectEvent((messageId: string | null) => jump(messageId));
  useEffect(() => {
    const last = visited.current;
    if (last.messageId === messageId && last.visit === visit) return;
    const inThread = threadId !== undefined || (last.threadId !== undefined && last.messageId === messageId);
    if (inThread || goTo(messageId ?? null)) visited.current = { messageId, visit, threadId };
  }, [messageId, visit, threadId, state.connections]);
  const typists = Object.values(state.typing).filter(({ user }) => user.id !== me.id);
  const composer = useRef<ComposerHandle>(null);
  const { editing, editors } = useMessageEditors(composer);
  useImperativeHandle(ref, () => ({ focusComposer: editors.returnFocus }), [editors]);
  useGivingBack(state.messages, composer, givenBack);
  // A thread that covers the room leaves nothing of it to reach until it's closed.
  const covered = useMediaQuery(THREAD_COVERS_ROOM) && threadId !== undefined;

  // Up Arrow edits the newest message you wrote, unless it's still on its way, or the timeline is reading
  // older history and may not hold it.
  const editLastMessage = () => {
    if (state.hasNewer) return;
    const newest = newestWrittenBy(state.messages, me.id);
    if (newest && !isPending(newest)) editors.open(newest.id);
  };

  return (
    <>
      {/* The room's header and messages, placed in the page's grid as if they were its own. */}
      <div className="contents" inert={covered}>
        <RoomHeader
          room={room}
          name={name}
          meId={me.id}
          present={state.present}
          status={state.status}
          offline={state.offline}
          favorite={favorite}
          onStarred={onStarred}
          involvement={involvement}
          askForRoom={askForRoom}
          onSessionChanged={onSessionChanged}
          onFailed={onFailed}
        />
        {/* Backgrounds run under a landscape phone's notch; the room's contents stay clear of it. */}
        <MainContent className="relative flex min-h-0 min-w-0 flex-col bg-background pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]">
          <RoomNotice notice={state.notice} onDismiss={dismissNotice} />
          <MessageList
            roomName={name}
            direct={direct}
            invitation={invitation}
            onDismissInvitation={onDismissInvitation}
            state={state}
            me={me}
            actions={deleted ? null : messageActions}
            editing={editing}
            editors={editors}
            onLoadOlder={loadOlder}
            onLoadNewer={loadNewer}
            onJumpToNewest={() => jump(null)}
            onDropFiles={(files) => composer.current?.addFiles(files)}
            openThread={threadId}
            newSince={newSince}
            joined={joinedIn(room)}
          />
          {deleted ? (
            <RoomDeleted />
          ) : (
            <Composer
              ref={composer}
              roomId={room.id}
              roomName={name}
              direct={direct}
              userId={me.id}
              typing={typists}
              disabled={state.offline}
              // Only while the room's first messages are on their way, not once it's been out of reach a while.
              deferEditor={state.status === "connecting" && !state.offline}
              // The thread open beside the room takes focus as it opens.
              autoFocus={threadId === undefined}
              onSend={postMessage}
              onSendFiles={postFiles}
              onTyping={typing}
              onEditLastMessage={editLastMessage}
            />
          )}
        </MainContent>
      </div>
      {threadId !== undefined && (
        <ThreadPanel
          key={threadId}
          room={room}
          name={name}
          me={me}
          parentId={threadId}
          replyId={replyId}
          frames={frames}
          status={state.status}
          offline={state.offline}
          deleted={deleted}
          roomNotice={covered ? state.notice : null}
          onDismissRoomNotice={dismissNotice}
        />
      )}
    </>
  );
}

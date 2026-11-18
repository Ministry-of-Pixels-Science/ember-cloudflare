import { useEffect, useEffectEvent, useMemo, useRef, type ReactNode } from "react";
import type { Me, Message, Room } from "@ember/protocol";
import { ArrowLeft, ChatBubbleEmpty, Xmark } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { PageLink } from "@/components/page-link";
import { useGivingBack } from "@/hooks/use-giving-back";
import { useMessageEditors } from "@/hooks/use-message-editors";
import type { RoomFrames } from "@/hooks/use-room";
import { roomPath, useVisit } from "@/hooks/use-route";
import { useThread } from "@/hooks/use-thread";
import { isPending, type ConnectionStatus } from "@/lib/room-state";
import { cn } from "@/lib/utils";
import { Composer, RoomDeleted, type ComposerHandle } from "./composer";
import { MessageItem, repliesLabel, type MessageActions, type MessageEditors, type ThreadPlace } from "./message-item";
import { MessageList } from "./message-list";
import { RoomNotice } from "./room-notice";

const ignore = () => {};
const noInvitation = async () => {};

interface Props {
  room: Room;
  /** The room's name as the reader reads it, which a DM's names the others in it. */
  name: string;
  me: Me;
  /** The message whose thread it is. */
  parentId: string;
  /** The reply whose permalink the address is, which the thread goes to. */
  replyId?: string;
  /** The room's socket, which the thread's frames come over too. */
  frames: RoomFrames;
  status: ConnectionStatus;
  offline: boolean;
  /** Whether the room has gone for this person, whose thread then stays as it is. */
  deleted: boolean;
  /** What the room has to say while the thread covers it, as why it refused something done in the thread. */
  roomNotice: string | null;
  onDismissRoomNotice: () => void;
}

/**
 * A message's thread, beside its room as Slack's is: a header with the room, and Close thread, then the
 * message and its replies, and a composer to reply with. From 1180px wide it's a column of its own at
 * the room's right, below that it covers the room, and on phones the whole page, with Back in its header
 * in Close thread's place.
 */
export function ThreadPanel({ room, name, me, parentId, replyId, frames, status, offline, deleted, roomNotice, onDismissRoomNotice }: Props) {
  const thread = useThread(room.id, frames, status, offline, me, parentId, replyId);

  // Following a reply's permalink in the thread goes to it, or the thread's own link to its end, as a
  // room's permalinks do.
  const visit = useVisit();
  const visited = useRef({ replyId, visit });
  const goTo = useEffectEvent((id: string | null) => thread.jump(id));
  useEffect(() => {
    if (visited.current.replyId === replyId && visited.current.visit === visit) return;
    visited.current = { replyId, visit };
    goTo(replyId ?? null);
  }, [replyId, visit]);

  const back = roomPath(room.id);

  return (
    <aside
      data-thread
      aria-label="Thread"
      className={cn(
        // Placed in the room's column, or the page's on phones, over the room, and from 1180px wide in its own.
        "absolute inset-0 z-10 col-start-3 row-span-2 row-start-1 flex min-h-0 min-w-0 flex-col bg-background max-md:col-start-1",
        "pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)] min-[1180px]:relative min-[1180px]:col-start-4 min-[1180px]:border-l",
      )}
    >
      <header className="flex min-h-header items-center gap-2.5 border-b py-2.5 pr-3.5 pl-5 max-md:min-h-[calc(56px+env(safe-area-inset-top))] max-md:gap-1.5 max-md:px-2 max-md:pt-[env(safe-area-inset-top)] max-md:pb-0">
        <PageLink href={back} aria-label={`Back to ${name}`} className="hidden size-11 shrink-0 items-center justify-center rounded-lg max-md:flex">
          <ArrowLeft className="size-[22px]" />
        </PageLink>
        <div className="flex min-w-0 items-center gap-2.5 max-md:flex-col max-md:items-start max-md:gap-0">
          <h2 className="shrink-0 text-[17px] leading-[1.4] font-[650] max-md:text-base max-md:leading-5">Thread</h2>
          {/* The room's name links to it, but on phones, as the line under Thread, too near the thread for a fingertip, it doesn't: Back does. */}
          <PageLink
            href={back}
            className={cn(ROOM_NAME, "relative hover:text-foreground max-md:hidden touch:after:absolute touch:after:inset-y-[calc(50%-22px)] touch:after:-inset-x-1")}
          >
            <RoomLabel room={room} name={name} />
          </PageLink>
          <span className={cn(ROOM_NAME, "hidden max-md:inline-flex")}>
            <RoomLabel room={room} name={name} />
          </span>
        </div>
        <PageLink
          href={back}
          title="Close thread"
          aria-label="Close thread"
          className="ml-auto grid size-9 shrink-0 place-items-center rounded-[10px] text-foreground hover:bg-hover touch:size-11 max-md:hidden"
        >
          <Xmark className="size-5" />
        </PageLink>
      </header>
      <ThreadReplies room={room} name={name} me={me} thread={thread} offline={offline} deleted={deleted} roomNotice={roomNotice} onDismissRoomNotice={onDismissRoomNotice} />
    </aside>
  );
}

interface RepliesProps {
  room: Room;
  /** The room's name as the reader reads it. */
  name: string;
  me: Me;
  /** The thread, as `useThread` keeps it over the socket it's shown by. */
  thread: ReturnType<typeof useThread>;
  offline: boolean;
  /** Whether the room has gone for this person. */
  deleted: boolean;
  /** What the room has to say that shows nowhere else while the thread does. */
  roomNotice: string | null;
  onDismissRoomNotice: () => void;
  /** What stands over the replies in the thread's message's place, where a thread shows without it, as a huddle's does. */
  intro?: ReactNode;
  /** Whether the composer takes the focus as it shows, as it does unless something else is to keep it, as a huddle is that opens with its thread. */
  autoFocus?: boolean;
  /** Whether the people the composer's @ lists show above the text with a mouse too, as where the panel ends over something that would cut the list off. */
  mentionsAbove?: boolean;
}

/**
 * A thread under its panel's header, wherever the panel is: what the room has to say, the thread's
 * message over its replies, and a composer to reply with, while the room has the message.
 */
export function ThreadReplies({ room, name, me, thread, offline, deleted, roomNotice, onDismissRoomNotice, intro, autoFocus, mentionsAbove }: RepliesProps) {
  const { parentId, parent, replies } = thread.state;
  // Replying tells nobody you're typing, so only @ember shows as typing here, as it answers in the thread.
  const typing = useMemo(() => Object.values(replies.typing), [replies.typing]);
  const direct = room.kind === "direct";
  const composer = useRef<ComposerHandle>(null);
  const { editing, editors } = useMessageEditors(composer);
  useGivingBack(replies.messages, composer, thread.givenBack);
  const actions = deleted ? null : thread.messageActions;

  // Up Arrow edits your newest reply, as the room's composer edits your newest message.
  const editLastReply = () => {
    const newest = replies.messages.findLast((message) => message.creator.id === me.id);
    if (newest && !isPending(newest)) editors.open(newest.id);
  };

  const place: ThreadPlace = { roomName: name, direct };
  return (
    <>
      <RoomNotice notice={replies.notice} onDismiss={thread.dismissNotice} />
      <RoomNotice notice={roomNotice} onDismiss={onDismissRoomNotice} />
      <MessageList
        roomName={name}
        direct={direct}
        invitation={null}
        onDismissInvitation={noInvitation}
        state={replies}
        me={me}
        actions={actions}
        editing={editing}
        editors={editors}
        onLoadOlder={thread.loadOlder}
        onLoadNewer={ignore}
        onJumpToNewest={() => {
          thread.jump(null);
          return true;
        }}
        onDropFiles={(files) => composer.current?.addFiles(files)}
        thread={{ header: intro ?? <ThreadParent parent={parent} me={me} editing={editing} actions={actions} editors={editors} place={place} />, place }}
      />
      {deleted ? (
        <RoomDeleted />
      ) : (
        parent !== null && (
          <Composer
            ref={composer}
            roomId={room.id}
            roomName={name}
            direct={direct}
            userId={me.id}
            typing={typing}
            disabled={offline}
            threadId={parentId}
            onSend={thread.postReply}
            onSendFiles={(files, alsoSend) => void thread.postFiles(files, alsoSend)}
            onTyping={ignore}
            onEditLastMessage={editLastReply}
            autoFocus={autoFocus}
            mentionsAbove={mentionsAbove}
          />
        )
      )}
    </>
  );
}

const ROOM_NAME = "inline-flex max-w-full min-w-0 items-center gap-[5px] text-sm leading-5 text-muted-foreground no-underline max-md:text-[13px] max-md:leading-[17px]";

/** The room's icon, or a DM's, and its name. */
function RoomLabel({ room, name }: { room: Room; name: string }) {
  return (
    <>
      {room.kind === "direct" ? <ChatBubbleEmpty className="size-4 shrink-0" /> : <RoomIcon icon={room.icon} size={16} className="shrink-0 text-[16px] leading-none" />}
      <span className="truncate">{name}</span>
    </>
  );
}

interface ParentProps {
  parent: Message | null | undefined;
  me: Me;
  editing: ReadonlySet<string>;
  actions: MessageActions | null;
  editors: MessageEditors;
  place: ThreadPlace;
}

/**
 * The thread's message, over its replies, and how many there are, between them. Until the room has sent
 * it, nothing shows, and once the room says it hasn't one, that it's gone.
 */
function ThreadParent({ parent, me, editing, actions, editors, place }: ParentProps) {
  if (parent === undefined) return null;
  if (parent === null) return <p className="px-5 py-2 text-[15px] leading-[22px] text-message-muted max-md:px-3">This message no longer exists.</p>;
  const count = parent.thread?.count ?? 0;
  return (
    <>
      <MessageItem message={parent} me={me} threaded={false} editing={editing.has(parent.id)} actions={actions} editors={editors} thread={place} />
      {count > 0 && (
        <div className="mx-5 mt-2 mb-1.5 flex items-center gap-3 text-[13px] leading-[18px] text-message-muted after:flex-1 after:border-t after:border-message-divider touch:mx-3 touch:mt-1.5 touch:mb-1">
          <span>{repliesLabel(count)}</span>
        </div>
      )}
    </>
  );
}

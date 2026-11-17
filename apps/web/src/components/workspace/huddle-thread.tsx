import type { Me, Room } from "@ember/protocol";
import { Xmark } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { useRoomApart } from "@/hooks/use-room-apart";
import { useThread } from "@/hooks/use-thread";
import { roomName } from "@/lib/directs";
import { ThreadReplies } from "./thread-panel";

interface IntroProps {
  /** Where the thread stays, as "in" goes on: the room's name, or "this direct message". */
  place: string;
  /** Whether the room has said that it has no message of the huddle. */
  gone: boolean;
}

/**
 * What the huddle's thread says in its message's place, which the room shows: what the thread is for,
 * or, once the room has no message of the huddle, as when it's been deleted, that it has no thread.
 */
function Intro({ place, gone }: IntroProps) {
  if (gone) return <p className="px-5 pb-3 text-sm leading-[1.5] text-message-muted">This huddle’s message isn’t in {place}, so it has no thread.</p>;
  return (
    <div className="px-5 pb-3">
      <p className="text-[15px] leading-[22px] font-bold text-message-ink">Every huddle has a thread</p>
      <p className="mt-0.5 text-sm leading-[1.5] text-message-muted">Messages, files and links sent here reach everyone in the huddle, and stay as a thread in {place} once it ends.</p>
    </div>
  );
}

interface Props {
  /** The huddle's room. */
  room: Room;
  me: Me;
  /** The room's message of the huddle, whose thread this is. */
  messageId: string;
  /** Whether its composer takes the focus as the thread shows, as it does once its person has asked for the thread: one that shows as the huddle opens leaves the focus on the huddle. */
  autoFocus: boolean;
  onClose: () => void;
}

/**
 * The huddle's thread, beside the people in it, where Slack's huddle window has it: the thread of the
 * room's message of the huddle, with a composer to reply in, under a header with Close thread. It
 * comes over a socket of its own to the huddle's room, since the huddle opened covers whatever page is
 * under it, which may be another room's, and through it the room isn't read, as it's the thread
 * that's shown and not the room. Under it are the huddle's own buttons, which it keeps clear of: in a
 * window too short for it, it scrolls, and the people its composer's @ lists show above the text,
 * since under it they'd be cut off where the panel ends.
 */
export function HuddleThread({ room, me, messageId, autoFocus, onClose }: Props) {
  const name = roomName(room, me.id, useNameOf());
  const { frames, status, offline, notice, dismissNotice } = useRoomApart(room.id, me.id);
  const thread = useThread(room.id, frames, status, offline, me, messageId);
  const place = room.kind === "direct" ? "this direct message" : name;
  return (
    <aside aria-label="Huddle thread" className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l bg-background">
      <header className="flex min-h-[52px] items-center border-b py-2 pr-2.5 pl-5">
        <h3 className="text-[15px] leading-[1.4] font-[650]">Thread</h3>
        <button type="button" title="Close thread" aria-label="Close thread" onClick={onClose} className="ml-auto grid size-9 cursor-pointer place-items-center rounded-[10px] hover:bg-hover">
          <Xmark className="size-5" />
        </button>
      </header>
      <ThreadReplies
        room={room}
        name={name}
        me={me}
        thread={thread}
        offline={offline}
        deleted={status === "gone"}
        roomNotice={notice}
        onDismissRoomNotice={dismissNotice}
        intro={<Intro place={place} gone={thread.state.parent === null} />}
        autoFocus={autoFocus}
        mentionsAbove
      />
    </aside>
  );
}

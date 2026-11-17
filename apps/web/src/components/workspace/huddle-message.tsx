import { useContext } from "react";
import type { RoomId, User, UserId } from "@ember/protocol";
import type { MessageHuddle } from "@ember/protocol/huddles";
import { Headset } from "@/components/icons/iconoir";
import { useAccount } from "@/hooks/use-account";
import { PeopleContext } from "@/hooks/use-directory";
import { useHuddle } from "@/hooks/use-huddle";
import { huddleLasted, inItsHuddle, wereInTheHuddle } from "@/lib/huddle-people";
import { cn } from "@/lib/utils";
import { HuddlesContext } from "./huddle-button";
import { UserAvatar } from "./user-avatar";

// What a huddle's message shows in its room (`Message.huddle`), as Slack's does, where any other message
// shows its author and its text: the headphones where a face goes, "A huddle is happening" with LIVE,
// who's in it and Join, and once the huddle is over, who was in it and for how long. Its time, reactions,
// thread and actions are a message's own (./message-item.tsx).

/** How many faces a huddle's message shows of the people in its huddle. */
const MAX_FACES = 4;

/** Whether a huddle's message is of a huddle that's going on, which it is until it says when the huddle ended. */
export const isLive = (huddle: MessageHuddle) => huddle.endedAt === undefined;

/** What a huddle's message has where its author's face would be: the headphones, on green while the huddle goes on. */
export function HuddleTile({ huddle }: { huddle: MessageHuddle }) {
  return (
    <span aria-hidden className={cn("mt-2 grid size-9 place-items-center rounded-[6px] max-md:size-[30px]", isLive(huddle) ? "bg-positive text-white" : "bg-border text-message-muted")}>
      <Headset className="size-5 max-md:size-[18px]" />
    </span>
  );
}

/** What a huddle's message is headed with, where its author's name would be: that a huddle is happening, with LIVE, or that one happened. */
export function HuddleTitle({ huddle }: { huddle: MessageHuddle }) {
  return (
    <>
      <strong className="truncate font-bold text-message-ink">{isLive(huddle) ? "A huddle is happening" : "A huddle happened"}</strong>
      {isLive(huddle) && <span className="self-center rounded-[4px] bg-positive px-1.5 text-[11px] leading-[18px] font-bold tracking-[0.04em] text-white">LIVE</span>}
    </>
  );
}

interface SummaryProps {
  huddle: MessageHuddle;
  /** The room the huddle is in, or was. */
  roomId: RoomId;
  /** Whose tab shows the message, whom its words call you. */
  meId: UserId;
}

/** What a huddle's message says of its huddle, under its heading. */
export function HuddleSummary({ huddle, roomId, meId }: SummaryProps) {
  return isLive(huddle) ? <GoingOn startedAt={huddle.startedAt} roomId={roomId} meId={meId} /> : <Over huddle={huddle} meId={meId} />;
}

/** A huddle's message as its editor shows it, which can only delete it: what it's headed with, then what it says of its huddle. */
export function HuddleShown(props: SummaryProps) {
  return (
    <>
      <p className="flex min-h-[22px] items-baseline gap-2 text-[15px] leading-[22px]">
        <HuddleTitle huddle={props.huddle} />
      </p>
      <HuddleSummary {...props} />
    </>
  );
}

const ROW = "mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 touch:pr-8";
// A first name that's one long word breaks where the row ends, on the narrowest phone.
const WORDS = "text-[15px] leading-[22px] wrap-anywhere text-message-ink";

/** The first faces of the people in a huddle, overlapping, each ringed in the page's color, which parts it from the face it overlaps. */
function Faces({ people }: { people: User[] }) {
  return (
    <span aria-hidden className="flex shrink-0 -space-x-1.5">
      {people.slice(0, MAX_FACES).map((person) => (
        <UserAvatar key={person.id} user={person} className="size-6 ring-2 ring-background" />
      ))}
    </span>
  );
}

/**
 * Of a huddle that's going on: the faces of the first people in it and who they all are, as the sidebar
 * last heard of the room's huddle, while that's the one that started when the message says, and Join,
 * which opens the preview a huddle is joined from, unless this tab is in the room's huddle. Nothing where
 * there's neither to show.
 */
function GoingOn({ startedAt, roomId, meId }: { startedAt: string; roomId: RoomId; meId: UserId }) {
  const { live, preview } = useContext(HuddlesContext);
  const people = useContext(PeopleContext);
  const here = useHuddle()?.roomId === roomId;
  const joinable = useAccount().huddles && !here;
  const going = live[roomId];
  const inIt = going?.startedAt === startedAt ? going.userIds : [];
  if (inIt.length === 0 && !joinable) return null;
  const others = inIt.filter((userId) => userId !== meId);
  return (
    <div className={ROW}>
      {inIt.length > 0 && (
        <>
          <Faces people={inIt.flatMap((userId) => people.get(userId) ?? [])} />
          <span className={WORDS}>{inItsHuddle(others.flatMap((userId) => people.get(userId)?.name ?? []), others.length, others.length < inIt.length)}</span>
        </>
      )}
      {joinable && (
        <button
          type="button"
          onClick={() => preview(roomId)}
          className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-positive px-3 text-sm font-semibold text-white hover:brightness-95 touch:min-h-11"
        >
          <Headset className="size-4" />
          Join
        </button>
      )}
    </div>
  );
}

/** Of a huddle that's over: the faces of the first people who were in it, who they all were, by the names the people directory has for them now, and how long it went on. */
function Over({ huddle, meId }: { huddle: MessageHuddle; meId: UserId }) {
  const people = useContext(PeopleContext);
  const inIt = huddle.people ?? [];
  const others = inIt.filter((person) => person.id !== meId);
  return (
    <div className={ROW}>
      <Faces people={inIt} />
      <span className={WORDS}>
        {wereInTheHuddle(others.map((person) => people.get(person.id)?.name ?? person.name), others.length < inIt.length)} for {huddleLasted(huddle.startedAt, huddle.endedAt!)}
      </span>
    </div>
  );
}

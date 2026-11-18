import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Me, PastHuddle, SidebarRoom, UserId } from "@ember/protocol";
import { Headset } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { MainContent } from "@/components/main-content";
import { PageLink } from "@/components/page-link";
import { useAccount } from "@/hooks/use-account";
import { PeopleContext, useNameOf } from "@/hooks/use-directory";
import { useHuddle } from "@/hooks/use-huddle";
import { roomPath, threadPath } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { fetchHuddles, isSignedOut } from "@/lib/api";
import { membersShown, roomName } from "@/lib/directs";
import { huddlesGoingOn, recentHuddles, type HuddleGoingOn, type HuddleOver } from "@/lib/huddle-list";
import { huddleLasted, huddlePlace, inItsHuddle, wereInItsHuddle } from "@/lib/huddle-people";
import { isHidden } from "@/lib/involvement";
import { dateTimeLabel, huddleStartedLabel, timeLabel } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { HuddlesContext, NO_HUDDLES } from "./huddle-button";
import { Faces, JoinHuddle, LiveBadge } from "./huddle-message";
import { repliesLabel } from "./message-item";
import { PageHeader } from "./page-header";
import { UserAvatar } from "./user-avatar";

/** How many of the others in a group DM its tile shows the faces of. */
const MAX_TILE_FACES = 4;

/** What heads each of the page's lists. */
const HEADING = "mb-2 text-[13px] font-semibold text-muted-foreground";

/** A room's name over what's said of its huddle. */
const NAME = "truncate text-[15px] leading-[22px] font-bold text-foreground";

/** What's said of a huddle under its room's name. */
const WORDS = "text-[13px] leading-[18px] text-muted-foreground wrap-anywhere";

interface Props {
  me: Me;
  /** The rooms and DMs the sidebar lists, which the huddles are named by, or null until they've come. */
  rooms: SidebarRoom[] | null;
  /** How many times the sidebar has heard that the huddles that are over may have changed, each of which asks for them again. */
  changes: number;
  /** Says why the huddles couldn't be loaded, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * The Huddles page, at `/huddles`, after Slack's. Where huddles are on, Happening now lists the huddles
 * going on in your rooms and DMs, as the sidebar hears of them, each with who's in it, when it started
 * and Join. Recent huddles lists the latest that are over, as Slack's page does: each with its room, when
 * it started, how long it went on, how many replies its thread has, and the faces of who was in it, and
 * each goes to its thread. A huddle nobody else joined is listed only while its thread has a reply, and
 * those of a room you've hidden from your sidebar aren't listed. The list is asked for once your rooms
 * have come, and again as the sidebar hears a huddle is over or its thread has changed, as you're put in
 * a room or leave one, and as you hide one or show it again. Once it has come, one that can't be loaded
 * again leaves the page as it was.
 */
export function HuddlesPage({ me, rooms, changes, onFailed }: Props) {
  const huddlesOn = useAccount().huddles;
  const heard = useContext(HuddlesContext).live;
  const live = huddlesOn ? heard : NO_HUDDLES;
  const [past, setPast] = useState<PastHuddle[] | null>(null);
  const loaded = useRef(false);
  // The rooms whose huddles the server lists, whichever order the sidebar has them in, or null until they've come.
  const roomIds = useMemo(() => rooms && rooms.filter((room) => !isHidden(room)).map((room) => room.id).sort().join(" "), [rooms]);
  useTitle("Huddles");

  useEffect(() => {
    if (roomIds === null) return;
    let stopped = false;
    fetchHuddles().then(
      (huddles) => {
        if (stopped) return;
        loaded.current = true;
        setPast(huddles);
      },
      (error: unknown) => {
        // A page left before its huddles load, or one that has them already, only reports a session that's
        // ended, which goes to sign in.
        if (isSignedOut(error) || (!stopped && !loaded.current)) onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [roomIds, changes, onFailed]);

  const goingOn = useMemo(() => (rooms ? huddlesGoingOn(rooms, live) : []), [rooms, live]);
  const recent = useMemo(() => (rooms && past ? recentHuddles(past, rooms, live) : null), [rooms, past, live]);
  return (
    <>
      <PageHeader>
        <Headset className="size-[22px] shrink-0 text-muted-foreground" />
        <h1 className="truncate text-[17px] leading-[1.4] font-[650] max-md:text-base">Huddles</h1>
      </PageHeader>
      <MainContent
        aria-busy={recent === null || undefined}
        className="relative flex min-h-0 min-w-0 flex-col bg-background pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]"
      >
        <div className="min-h-0 flex-1 basis-0 overflow-x-hidden overflow-y-auto overscroll-contain px-[22px] pt-4 pb-[max(18px,env(safe-area-inset-bottom))] [scrollbar-gutter:stable] max-md:px-3 max-md:pt-3">
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
            {goingOn.length > 0 && (
              <section aria-labelledby="huddles-going-on">
                <h2 id="huddles-going-on" className={HEADING}>
                  Happening now
                </h2>
                <ul className="flex flex-col gap-2">
                  {goingOn.map(({ room, huddle }) => (
                    <GoingOn key={room.id} room={room} huddle={huddle} meId={me.id} />
                  ))}
                </ul>
              </section>
            )}
            {recent && (
              <section aria-labelledby="recent-huddles">
                <h2 id="recent-huddles" className={HEADING}>
                  Recent huddles
                </h2>
                {recent.length > 0 ? (
                  <ul className="-mx-2 divide-y">
                    {recent.map(({ room, huddle }) => (
                      <Over key={huddle.messageId} room={room} huddle={huddle} meId={me.id} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-[15px] leading-[22px] text-muted-foreground">No huddles yet. A huddle shows here once it’s over, if someone else joined it or its thread has a reply.</p>
                )}
              </section>
            )}
          </div>
        </div>
      </MainContent>
    </>
  );
}

/**
 * A huddle that's going on, as a card on green: its room, LIVE, who's in it and when it started, the
 * faces of the first of them, and Join, unless this tab is in it. The rest of the card goes to the room.
 */
function GoingOn({ room, huddle, meId }: HuddleGoingOn & { meId: UserId }) {
  const people = useContext(PeopleContext);
  const name = roomName(room, meId, useNameOf());
  const here = useHuddle()?.roomId === room.id;
  const others = huddle.userIds.filter((userId) => userId !== meId);
  const started = new Date(huddle.startedAt);
  return (
    <li className="relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-positive/30 bg-positive/8 px-4 py-3 max-md:px-3">
      <RoomTile room={room} meId={meId} live />
      <div className="min-w-0 flex-1 basis-[12em]">
        <p className="flex items-center gap-2">
          {/* Its link covers the card, under Join, which is raised above it. */}
          <PageLink href={roomPath(room.id)} className={cn(NAME, "no-underline after:absolute after:inset-0 hover:underline")}>
            {name}
          </PageLink>
          <LiveBadge className="shrink-0" />
        </p>
        <p className={WORDS}>
          {inItsHuddle(others.flatMap((userId) => people.get(userId)?.name ?? []), others.length, others.length < huddle.userIds.length)} <span aria-hidden>·</span>{" "}
          <span className="whitespace-nowrap">
            started{" "}
            <time dateTime={huddle.startedAt} title={dateTimeLabel(started)}>
              {timeLabel(started)}
            </time>
          </span>
        </p>
      </div>
      <Faces people={huddle.userIds.flatMap((userId) => people.get(userId) ?? [])} />
      {!here && (
        <span className="relative z-[1] flex shrink-0">
          <JoinHuddle roomId={room.id} label={`Join the huddle ${huddlePlace(room, name)}`} />
        </span>
      )}
    </li>
  );
}

/**
 * A huddle that's over, as a row, after Slack's: its room, when it started, how long it went on, and how
 * many replies its thread has, then the faces of the first who were in it, whom hovering them names, as
 * the words before them do for screen readers. The row goes to the huddle's thread.
 */
function Over({ room, huddle, meId }: HuddleOver & { meId: UserId }) {
  const people = useContext(PeopleContext);
  const name = roomName(room, meId, useNameOf());
  const others = huddle.userIds.filter((userId) => userId !== meId);
  const who = wereInItsHuddle(others.flatMap((userId) => people.get(userId)?.name ?? []), others.length, others.length < huddle.userIds.length);
  const started = new Date(huddle.startedAt);
  return (
    <li>
      <PageLink href={threadPath(room.id, huddle.messageId)} className="flex items-center gap-3 px-2 py-2.5 no-underline hover:bg-hover">
        <RoomTile room={room} meId={meId} />
        <span className="min-w-0 flex-1">
          <strong className={cn("block", NAME)}>{name}</strong>
          <span className={cn("block", WORDS)}>
            <time dateTime={huddle.startedAt} title={dateTimeLabel(started)}>
              {huddleStartedLabel(started)}
            </time>{" "}
            <span aria-hidden>·</span> {huddleLasted(huddle.startedAt, huddle.endedAt)}
            {huddle.replies > 0 && (
              <>
                {" "}
                <span aria-hidden>·</span> <span className="font-medium whitespace-nowrap text-link">{repliesLabel(huddle.replies)}</span>
              </>
            )}
          </span>
          <span className="sr-only">{who}</span>
        </span>
        <span title={who} className="flex shrink-0">
          <Faces people={huddle.userIds.flatMap((userId) => people.get(userId) ?? [])} />
        </span>
      </PageLink>
    </li>
  );
}

/**
 * What a huddle's room is shown by: a shared room's icon on a tile, on green while its huddle goes on, as
 * the headphones of a huddle's message are, and a DM's others' faces, one as a message shows it, or up to
 * four, two to a row.
 */
function RoomTile({ room, meId, live = false }: { room: SidebarRoom; meId: UserId; live?: boolean }) {
  if (room.kind !== "direct") {
    return (
      <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-[6px]", live ? "bg-positive text-white" : "bg-border text-message-muted")}>
        <RoomIcon icon={room.icon} size={20} className="text-[22px] leading-none" />
      </span>
    );
  }
  const members = membersShown(room, meId);
  if (members.length === 1) return <UserAvatar user={members[0]!} square className="size-9 shrink-0" />;
  return (
    <span aria-hidden className="grid size-9 shrink-0 grid-cols-2 place-content-center gap-0.5">
      {members.slice(0, MAX_TILE_FACES).map((member) => (
        <UserAvatar key={member.id} user={member} className="size-[17px]" />
      ))}
    </span>
  );
}

import { useContext, useId, useMemo, type MouseEvent } from "react";
import type { Favorites, LiveHuddle, Me, RoomId, SidebarRoom, UserId } from "@ember/protocol";
import { ChatPlusIn, Headset, NavArrowRight, StarSolid } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { useAccount } from "@/hooks/use-account";
import { PeopleContext, useNameOf } from "@/hooks/use-directory";
import { NEW_DIRECT_PATH, roomPath } from "@/hooks/use-route";
import { useStarOrder } from "@/hooks/use-star-order";
import { membersShown } from "@/lib/directs";
import { inItsHuddle } from "@/lib/huddle-people";
import { apart, inDirectOrder, inSidebarOrder, markedUnread, type DirectSidebarRoom } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { AgentBadge, useIsWithAgent } from "./agent-badge";
import { opensNewDirect } from "./new-direct-dialog";
import { UserAvatar } from "./user-avatar";

/** A row of the list, a room's or a DM's. */
const ROW =
  "flex min-h-9 items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-sm leading-[22px] text-foreground no-underline touch:min-h-11 hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:font-semibold";

/** How many avatars a group DM's row shows. */
const MAX_FACES = 4;

/** How many of the people in a huddle its room's row shows the faces of. */
const MAX_HUDDLE_FACES = 2;

interface Props {
  /** The workspace's name, which heads the list. */
  workspaceName: string;
  /** Who the sidebar is for, whose DMs name the others in them. */
  meId: UserId;
  /** Someone's rooms and DMs, in the order they were put in them, which the rooms neither starred nor ranked keep. */
  rooms: SidebarRoom[];
  /** Whether their list has come, before which nothing says there's nothing in it. */
  loaded: boolean;
  /** The rooms they've starred, whose rows come first, end with a star, and can be moved among themselves. */
  favorites: Favorites;
  /** The rooms the workspace's shared order ranks, which come next, in its order. */
  sharedOrder: RoomId[];
  /** The huddles going on in their rooms, by room, whose rows say who's in them. */
  huddles: Record<RoomId, LiveHuddle>;
  currentRoomId: string | null;
  /** Whether Activity is on, which shows only the rows marked unread. */
  unreadOnly: boolean;
  /** How many AI agents they can ask, which Available Agents says, under the DMs, while there are any. */
  agents: number;
  /** Whether Available Agents is open. */
  agentsOpen: boolean;
  onSelect: (roomId: string) => void;
  /** Opens New direct message, which the DMs heading's link does in place, from the link that opened it. */
  onNewDirect: (opener: HTMLElement) => void;
  /** Opens Available Agents, from the row that says how many there are. */
  onOpenAgents: (opener: HTMLElement) => void;
  /** Called with this person's stars as the server answers them, once a new order for them is saved. */
  onStarred: (favorites: Favorites) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

/**
 * The conversation list: rooms, then DMs, under the workspace name, and under that in small type the
 * tagline an administrator gave it, if it has one. The starred rooms come first, then the ones the
 * shared order ranks, in its order, then the rest in the order they were put in them, so a new room
 * comes last, and a starred room's row ends with a star, with no grip, both as the project's owner
 * chose: held, the row can be dragged among the other starred rows, or moved with Alt and an arrow
 * (`useStarOrder`). The DMs follow, only the ones they're in, as the project's owner chose, rather than
 * Campfire's people to start one with too, latest active first, and a DM's row shows who else is in it.
 * A room or DM marked unread is bold with a dot at the end of its row, and one with a huddle going on
 * ends its row with who's in it. With Activity on, only the unread rows show, and with none it says
 * everything's read; with it off and nothing to list, it says it found nothing. Under them all,
 * Available Agents says how many AI agents this person can ask, and opens the list of them, as the
 * project's owner chose (2026-11-15), unless there are none, or Activity is on.
 */
export function Sidebar({
  workspaceName,
  meId,
  rooms,
  loaded,
  favorites,
  sharedOrder,
  huddles,
  currentRoomId,
  unreadOnly,
  agents,
  agentsOpen,
  onSelect,
  onNewDirect,
  onOpenAgents,
  onStarred,
  onSessionChanged,
}: Props) {
  const { tagline } = useAccount();
  const { shared, directs } = useMemo(() => apart(unreadOnly ? rooms.filter((room) => markedUnread(room, currentRoomId)) : rooms), [rooms, unreadOnly, currentRoomId]);
  const shown = useMemo(() => new Set(shared.map((room) => room.id)), [shared]);
  const nameOf = (roomId: RoomId) => {
    const room = rooms.find((r) => r.id === roomId);
    return room && room.kind !== "direct" ? room.name : "";
  };
  const { order, moving, status, listRef, scrollerRef, listProps } = useStarOrder({ favorites, shown, nameOf, onSaved: onStarred, onSessionChanged });
  const listed = useMemo(() => inSidebarOrder(shared, order, sharedOrder), [shared, order, sharedOrder]);
  const starred = useMemo(() => new Set(order), [order]);
  const directsListed = useMemo(() => inDirectOrder(directs), [directs]);
  const empty = loaded && listed.length === 0 && directsListed.length === 0;
  const helpId = useId();
  const unreadId = useId();
  const huddleId = useId();
  // A row followed in place shows its room here, and one opened elsewhere, as in a new tab, leaves this page be.
  const select = (event: MouseEvent, roomId: RoomId) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onSelect(roomId);
  };
  return (
    <div ref={scrollerRef} className="flex h-full flex-col gap-3.5 overflow-y-auto overflow-x-hidden bg-surface px-3 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] [scrollbar-gutter:stable] narrow:px-2 max-md:gap-4 max-md:px-2.5 max-md:pt-4 max-md:pb-[max(16px,env(safe-area-inset-bottom))]">
      {/* The workspace's heading, as an hgroup, HTML's element for a heading and its tagline. At 900px and
          below the drawer's close button sits at the end of the name's row, and the tagline keeps clear of it
          too. A long name wraps rather than running under the sidebar's edge, and so does a tagline in a
          narrower sidebar or wider letters than its length allows for. */}
      <hgroup className="px-1.5 max-md:pr-10">
        <h2 className="flex min-h-7 items-center gap-2 text-[17px] leading-6 font-[650] wrap-anywhere">{workspaceName}</h2>
        {tagline && <p className="text-[13px] leading-[18px] text-muted-foreground wrap-anywhere">{tagline}</p>}
      </hgroup>

      <section aria-label="Rooms" className="flex flex-col">
        <p id={helpId} className="sr-only">
          Hold a starred room to drag it, or press Alt and the up or down arrow to reorder your favorites. Other rooms follow the workspace order.
        </p>
        <span id={unreadId} hidden>
          Unread
        </span>
        <div ref={listRef} {...listProps} className={cn("flex flex-col gap-[3px]", moving && "select-none")}>
          {listed.map((room) => {
            const unread = markedUnread(room, currentRoomId);
            const star = starred.has(room.id);
            const huddle = huddles[room.id];
            // The words for who's in the room's huddle, which come with its mark.
            const inHuddleId = `${huddleId}-${room.id}`;
            return (
              <a
                key={room.id}
                data-room-id={room.id}
                href={roomPath(room.id)}
                draggable={false}
                aria-current={room.id === currentRoomId ? "page" : undefined}
                // Every row says how the stars are reordered, a marked one says it's unread, which the eye sees
                // by its weight and dot, and one with a huddle says who's in it, which the eye sees by its mark.
                aria-describedby={[huddle && inHuddleId, unread && unreadId, helpId].filter(Boolean).join(" ")}
                aria-keyshortcuts={star ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onClick={(event) => select(event, room.id)}
                className={cn(
                  ROW,
                  "[-webkit-touch-callout:none]",
                  unread && "font-[650]",
                  star && "cursor-grab",
                  room.id === moving && "relative z-[1] cursor-grabbing bg-background! shadow-[0_4px_14px_var(--color-drag-shadow)] outline outline-muted-foreground",
                )}
              >
                <RoomIcon icon={room.icon} size={19} className="w-[18px] shrink-0 text-center text-[22px] leading-none text-muted-foreground" />
                <span className="truncate">{room.name}</span>
                {/* The huddle's mark, the dot and the star sit together at the row's end, pushed there by one auto
                    margin. The star's muted at 65%. */}
                {huddle && <HuddleMark huddle={huddle} meId={meId} wordsId={inHuddleId} className="ml-auto" />}
                {unread && <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full bg-foreground", !huddle && "ml-auto")} />}
                {star && <StarSolid aria-label="Favorite" className={cn("size-3.5 shrink-0 text-muted-foreground/65", !huddle && !unread && "ml-auto")} />}
              </a>
            );
          })}
        </div>
        {/* Moves are told to screen readers, and a save that fails is shown. */}
        <p role="status" className={status?.error ? "mx-[9px] my-1 text-xs leading-normal text-negative wrap-anywhere" : "sr-only"}>
          {status?.message}
        </p>
      </section>

      <section aria-labelledby="directs-heading" className="flex flex-col gap-[3px]">
        <div className="mb-[5px] flex items-center gap-2 px-[9px] text-xs font-medium text-muted-foreground">
          <h3 id="directs-heading">DMs</h3>
          <a
            href={NEW_DIRECT_PATH}
            title="New direct message"
            aria-label="New direct message"
            onClick={opensNewDirect(onNewDirect)}
            className="ml-auto flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-hover touch:size-11"
          >
            <ChatPlusIn className="size-[15px]" />
          </a>
        </div>
        {directsListed.map((room) => (
          <DirectRow
            key={room.id}
            room={room}
            meId={meId}
            current={room.id === currentRoomId}
            unreadId={markedUnread(room, currentRoomId) ? unreadId : null}
            huddle={huddles[room.id]}
            onClick={(event) => select(event, room.id)}
          />
        ))}
      </section>
      {empty && (
        <p className="px-[9px] text-[13px] text-muted-foreground">{unreadOnly ? "You’re all caught up. No unread conversations." : "No conversations found."}</p>
      )}
      {agents > 0 && !unreadOnly && <AgentsRow count={agents} open={agentsOpen} onOpen={onOpenAgents} />}
    </div>
  );
}

/**
 * Available Agents: a heading, as the DMs' is, that's a button, with how many AI agents this person can
 * ask on a pill, as the Agent badge's is, and an arrow, since it opens the list of them.
 */
function AgentsRow({ count, open, onOpen }: { count: number; open: boolean; onOpen: (opener: HTMLElement) => void }) {
  return (
    <section aria-label="Agents" className="flex flex-col">
      <button
        type="button"
        // Named in one piece, since a browser reads a space between the parts of a row laid out as this one is.
        aria-label={`Available Agents, ${count} to ask`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => onOpen(event.currentTarget)}
        className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-[9px] text-start text-xs font-medium text-muted-foreground touch:min-h-11 hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground"
      >
        <span>Available Agents</span>
        <span aria-hidden="true" className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground/8 px-1.5 text-[11px] leading-none font-semibold tabular-nums text-message-muted">
          {count}
        </span>
        <NavArrowRight className="ml-auto size-[15px]" />
      </button>
    </section>
  );
}

interface HuddleMarkProps {
  huddle: LiveHuddle;
  /** Who the sidebar is for, whom the words call you. */
  meId: UserId;
  /** The id of the words that say who's in the huddle, for the row to be described by. */
  wordsId: string;
  className?: string;
}

/**
 * What a room's row, or a DM's, ends with while a huddle is going on in it, as Slack's does: the faces
 * of the first two people in it, the headphones and how many are in it, in green. Hovering it says who
 * they are, in the words that follow it, hidden, for the row to say to screen readers, which the mark is
 * hidden from.
 */
function HuddleMark({ huddle, meId, wordsId, className }: HuddleMarkProps) {
  const people = useContext(PeopleContext);
  const faces = huddle.userIds.flatMap((userId) => people.get(userId) ?? []).slice(0, MAX_HUDDLE_FACES);
  const others = huddle.userIds.filter((userId) => userId !== meId);
  const who = inItsHuddle(others.flatMap((userId) => people.get(userId)?.name ?? []), others.length, others.length < huddle.userIds.length);
  return (
    <>
      <span aria-hidden="true" title={who} className={cn("flex shrink-0 items-center gap-1 text-xs font-medium text-positive", className)}>
        {/* Each ringed in the sidebar's color, which parts it from the face it overlaps. */}
        <span className="flex -space-x-1">
          {faces.map((person) => (
            <UserAvatar key={person.id} user={person} className="size-4 ring-1 ring-surface" />
          ))}
        </span>
        <Headset className="size-3.5" />
        <span className="tabular-nums">{huddle.userIds.length}</span>
      </span>
      <span id={wordsId} hidden>
        {who}
      </span>
    </>
  );
}

interface DirectRowProps {
  room: DirectSidebarRoom;
  meId: UserId;
  /** Whether it's the DM the tab shows. */
  current: boolean;
  /** The element saying the DM is unread, when it's marked so, or null. */
  unreadId: string | null;
  /** The huddle going on in it, if one is. */
  huddle: LiveHuddle | undefined;
  onClick: (event: MouseEvent) => void;
}

/**
 * A DM's row: the avatar of the one other person in it, or of up to four in a group, at 24px or 14px
 * each, then their names, or yours in a DM with yourself, and the agent badge in a DM with an AI agent
 * alone. It ends with who's in its huddle while one is going on, as a room's does.
 */
function DirectRow({ room, meId, current, unreadId, huddle, onClick }: DirectRowProps) {
  const nameOf = useNameOf();
  const isWithAgent = useIsWithAgent();
  const members = membersShown(room, meId);
  // The words for who's in its huddle, which come with its mark.
  const inHuddleId = useId();
  return (
    <a
      href={roomPath(room.id)}
      aria-current={current ? "page" : undefined}
      aria-describedby={[huddle && inHuddleId, unreadId].filter(Boolean).join(" ") || undefined}
      onClick={onClick}
      className={cn(ROW, unreadId && "font-[650]")}
    >
      {members.length > 1 ? (
        // Campfire's `.avatar__group` (avatars.css): two to a row, centered on the 24px a single avatar takes.
        <span aria-hidden="true" className="grid size-6 shrink-0 grid-cols-2 grid-rows-[min-content] place-content-center gap-px">
          {members.slice(0, MAX_FACES).map((member) => (
            <UserAvatar key={member.id} user={member} className="size-3.5" />
          ))}
        </span>
      ) : (
        members.map((member) => <UserAvatar key={member.id} user={member} className="size-6" />)
      )}
      {/* The space after the hidden words starts the visible line, where it doesn't show. */}
      <span className="min-w-0 flex-1 truncate">
        <span className="sr-only">Direct message with</span> {members.map((member) => `${nameOf(member)}${member.id === meId ? " (you)" : ""}`).join(", ")}
        {isWithAgent(room) && <AgentBadge className="ms-0.5" />}
      </span>
      {huddle && <HuddleMark huddle={huddle} meId={meId} wordsId={inHuddleId} />}
      {unreadId && <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-foreground" />}
    </a>
  );
}

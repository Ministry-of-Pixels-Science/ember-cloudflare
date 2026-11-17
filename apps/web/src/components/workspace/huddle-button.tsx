import { createContext, useCallback, useContext } from "react";
import type { DirectoryUser, LiveHuddle, RoomId, User } from "@ember/protocol";
import { Headset, Link, NavArrowDown } from "@/components/icons/iconoir";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PeopleContext } from "@/hooks/use-directory";
import { useHuddle } from "@/hooks/use-huddle";
import { huddlePath } from "@/hooks/use-route";
import { copyWithSuccess } from "@/lib/clipboard";
import { leaveHuddle } from "@/lib/huddle-store";
import { huddleShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { isBot } from "./user-avatar";

/** What a room's header knows of huddles. */
export interface Huddles {
  /** The huddles going on in this person's rooms, by room, as the sidebar last heard. */
  live: Record<RoomId, LiveHuddle>;
  /** Opens the preview that the huddle in a room is started or joined from. */
  preview: (roomId: RoomId) => void;
}

export const NO_HUDDLES: Huddles["live"] = {};

/** The huddles going on, and the way into one, for a room's header. */
export const HuddlesContext = createContext<Huddles>({ live: NO_HUDDLES, preview: () => {} });

/**
 * Whether someone joins no huddle, as the people directory lists them: a bot, AI agents among them, or
 * someone who can no longer sign in, deactivated, banned or suspended. Until it lists them, only @ember
 * is known to join none.
 */
export const joinsNoHuddle = (user: User, listed: DirectoryUser | undefined) => isBot(user, listed) || (listed !== undefined && listed.status !== "active");

/** Whether someone joins no huddle, as the people directory lists them now. */
export function useJoinsNoHuddle(): (user: User) => boolean {
  const people = useContext(PeopleContext);
  return useCallback((user: User) => joinsNoHuddle(user, people.get(user.id)), [people]);
}

/** One half of the button, which a pointer highlights by itself. */
const HALF = "grid cursor-pointer place-items-center hover:bg-foreground/8 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground";

/**
 * The huddle button, first of a room's actions, where Slack's is: headphones that start the room's huddle,
 * join the one going on, or leave it once this tab is in it, and an arrow whose menu copies the huddle's
 * link. It's green while the tab is in the huddle, and outlined in green, with how many are in it, while
 * others are and the tab isn't. Starting and joining go by the preview, which asks for the microphone.
 */
export function HuddleButton({ roomId }: { roomId: RoomId }) {
  const { live, preview } = useContext(HuddlesContext);
  const here = useHuddle()?.roomId === roomId;
  const others = here ? 0 : (live[roomId]?.userIds.length ?? 0);
  const label = here ? "Leave huddle" : others > 0 ? "Join huddle" : "Start huddle";
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-stretch overflow-hidden rounded-lg touch:h-11",
        here && "bg-positive text-white",
        others > 0 && "text-positive ring-1 ring-positive ring-inset",
      )}
    >
      <ShortcutTooltip label={label} shortcut={huddleShortcut()}>
        <button
          type="button"
          aria-label={others > 0 ? `${label}, ${others} in it` : label}
          onClick={() => (here ? leaveHuddle() : preview(roomId))}
          // A phone's header has no width to spare, so there the count costs the room's name as little as it can.
          className={cn(HALF, "min-w-9 grid-flow-col gap-1.5 px-2 touch:min-w-11 max-md:gap-1 max-md:px-1.5")}
        >
          <Headset className="size-5" />
          {/* Under 360px the count would leave the room's name no letters, and the green ring says a huddle's going on. */}
          {others > 0 && <span className="text-[13px] leading-none font-semibold tabular-nums max-[359px]:hidden">{others}</span>}
        </button>
      </ShortcutTooltip>
      <HuddleOptions roomId={roomId} />
    </div>
  );
}

/** The arrow beside the headphones, and its menu, which phones leave out, as Slack's do. */
function HuddleOptions({ roomId }: { roomId: RoomId }) {
  return (
    <Popover>
      <PopoverTrigger aria-label="Huddle options" className={cn(HALF, "w-5 touch:w-11 data-[state=open]:bg-foreground/8 max-md:hidden")}>
        <NavArrowDown className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent aria-label="Huddle options" align="end" sideOffset={8} className="w-[210px] rounded-[12px] bg-background p-2 text-foreground shadow-[0_8px_24px_#0002]">
        <button
          type="button"
          onClick={(event) => void copyWithSuccess(event.currentTarget, location.origin + huddlePath(roomId))}
          className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-[7px] p-2 text-start hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
        >
          <Link className="size-[18px] shrink-0" />
          Copy huddle link
        </button>
      </PopoverContent>
    </Popover>
  );
}

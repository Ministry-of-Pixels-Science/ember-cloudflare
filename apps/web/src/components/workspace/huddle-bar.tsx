import { useEffect, useRef } from "react";
import type { Room, UserId } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { Expand, Headset } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { useIsSpeaking } from "@/hooks/use-huddle";
import { inTheHuddle, sharingScreens } from "@/lib/huddle-people";
import { openHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { cn } from "@/lib/utils";
import { CameraTool, LeaveButton, MicrophoneTool, RaiseHandTool, ScreenTool, TOOL, TOOL_OFF, useHuddleName, waitingToJoin } from "./huddle-tools";
import { UserAvatar } from "./user-avatar";

/** How many of the huddle's faces the bar shows. */
const MAX_FACES = 4;

/** One of the huddle's faces on its bar, ringed in green, over the faces beside it, while its person speaks. */
function Face({ person }: { person: HuddlePerson }) {
  const speaking = useIsSpeaking(person);
  return <UserAvatar user={person.user} className={cn("size-7 rounded-full ring-2", speaking ? "relative ring-positive" : "ring-background")} />;
}

interface Props {
  huddle: JoinedHuddle;
  /** Its room, or null once the room isn't among this person's. */
  room: Room | null;
  meId: UserId;
}

/**
 * The huddle this tab is in, minimized: a bar the whole width of the window, along its base, whatever
 * page shows above it, as Slack's is. The huddle's name and who's in it, which open it, their faces, the
 * microphone, the camera, the screen, Raise hand and the button that opens it, which phones leave to the
 * huddle opened, and Leave, in red and in words, last. A screen someone shares shows only in the huddle
 * opened, so the bar says who shares one in place of who's in it. Stickers and reactions show only
 * there too, and the bar says nothing of them.
 */
export function HuddleBar({ huddle, room, meId }: Props) {
  const nameOf = useNameOf();
  const name = useHuddleName(room, meId);
  const names = huddle.people.map(({ user }) => nameOf(user));
  const theOthers = huddle.people.filter(({ user }) => user.id !== huddle.you?.id);
  const others = theOthers.map(({ user }) => nameOf(user));
  const sharing = sharingScreens(
    theOthers.filter(({ screen }) => screen).map(({ user }) => nameOf(user)),
    huddle.screen !== null,
  );
  const open = () => openHuddle(true);
  // The button that minimized the huddle went with it, and left the focus nowhere, so the one that opens it again takes it.
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body) opener.current?.focus();
  }, []);
  return (
    <section
      aria-label={name}
      className="col-span-full row-start-4 flex min-h-[60px] items-center gap-3 border-t bg-background pt-2 pr-[max(16px,env(safe-area-inset-right))] pb-[max(8px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] max-md:gap-2 max-md:pr-[max(10px,env(safe-area-inset-right))] max-md:pl-[max(10px,env(safe-area-inset-left))]"
    >
      <button ref={opener} type="button" title="Open huddle" onClick={open} className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg py-1 pr-3 pl-1 text-start hover:bg-hover">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-positive text-white">
          <Headset className="size-5" />
        </span>
        <span className="min-w-0">
          {/* The space parts the two lines for screen readers, which hear the button as one. */}
          <span className="block truncate text-[15px] leading-5 font-semibold">{name}</span>{" "}
          <span aria-live="polite" className="block truncate text-xs leading-4 text-muted-foreground">
            {waitingToJoin(huddle) ?? sharing ?? inTheHuddle(others)}
          </span>
        </span>
      </button>
      <span aria-hidden title={names.join(", ")} className="flex shrink-0 -space-x-1.5 max-md:hidden">
        {huddle.people.slice(0, MAX_FACES).map((person) => (
          <Face key={person.user.id} person={person} />
        ))}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <MicrophoneTool huddle={huddle} />
        <CameraTool huddle={huddle} className="max-md:hidden" />
        <ScreenTool huddle={huddle} className="max-md:hidden" />
        <RaiseHandTool huddle={huddle} />
        <span aria-hidden className="mx-1 h-6 w-px bg-border max-md:hidden" />
        <button type="button" title="Open huddle" aria-label="Open huddle" onClick={open} className={cn(TOOL, TOOL_OFF, "max-md:hidden")}>
          <Expand />
        </button>
        <LeaveButton />
      </div>
    </section>
  );
}

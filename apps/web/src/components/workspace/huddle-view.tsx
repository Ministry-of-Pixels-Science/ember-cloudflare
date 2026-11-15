import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Room, UserId } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { Collapse, Headset, MicrophoneMute, NavArrowDown } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { OPEN_HUDDLE, openHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { TILE_GAP, tilesLayout } from "@/lib/huddle-tiles";
import { cn } from "@/lib/utils";
import { HuddlePicture } from "./huddle-picture";
import { CameraTool, LeaveButton, MicrophoneTool, useHuddleName, waitingToJoin } from "./huddle-tools";
import { UserAvatar } from "./user-avatar";

interface Space {
  width: number;
  height: number;
}

/**
 * The space an element has inside its padding, as its window changes, which the element measured takes
 * as its ref: nothing until it's measured, which is before it first shows.
 */
function useSpace(): [RefObject<HTMLDivElement | null>, Space] {
  const measured = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState<Space>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = measured.current;
    if (!element) return;
    const measure = () => {
      const { paddingLeft, paddingRight, paddingTop, paddingBottom } = getComputedStyle(element);
      const within = (size: number, ...paddings: string[]) => paddings.reduce((left, padding) => left - (parseFloat(padding) || 0), size);
      const [width, height] = [within(element.clientWidth, paddingLeft, paddingRight), within(element.clientHeight, paddingTop, paddingBottom)];
      setSpace((last) => (last.width === width && last.height === height ? last : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [measured, space];
}

interface TileProps {
  person: HuddlePerson;
  name: string;
  /** Whether they're this tab's person, who sees their own camera as a mirror would show it. */
  you: boolean;
  /** Their camera, while it's on and this tab has it to show. */
  picture: MediaStream | null;
  square: boolean;
}

/** Someone in the huddle: their camera's picture, or their avatar while it's off, over their name. */
function Tile({ person, name, you, picture, square }: TileProps) {
  return (
    <li className={cn("relative grid place-items-center overflow-hidden rounded-2xl border bg-background", square ? "aspect-square" : "aspect-[4/3]")}>
      {picture ? (
        <HuddlePicture stream={picture} label={you ? "Your camera" : `${name}'s camera`} mirrored={you} />
      ) : (
        // 96px on a tile at its widest, and smaller with the tile.
        <UserAvatar user={person.user} square className="aspect-square h-auto w-2/5 max-w-24 rounded-[16%]" />
      )}
      <span className="absolute bottom-2.5 left-2.5 flex max-w-[calc(100%-20px)] items-center gap-1.5 rounded-md bg-surface px-2 py-1 text-[13px] leading-5 font-medium max-md:bottom-1.5 max-md:left-1.5">
        {person.muted && <MicrophoneMute aria-label="Muted" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">
          {name}
          {you && " (you)"}
        </span>
      </span>
    </li>
  );
}

interface Props {
  huddle: JoinedHuddle;
  /** Its room, or null once the room isn't among this person's. */
  room: Room | null;
  meId: UserId;
}

/**
 * The huddle this tab is in, opened, inside Ember, over the page beside the sidebar, and over all of a
 * phone's: its name and how many are in it, a tile for each of them, as large as shows them all, and
 * along its base the microphone, the camera and Leave, where Slack has them. Minimizing it leaves the
 * huddle's bar under the page.
 */
export function HuddleView({ huddle, room, meId }: Props) {
  const nameOf = useNameOf();
  const name = useHuddleName(room, meId);
  const minimize = () => openHuddle(false);
  const count = huddle.people.length;
  const [tiles, space] = useSpace();
  const { columns, width, square } = tilesLayout(count, space.width, space.height);
  // It covers the page whatever had the focus there, so it takes it as it opens.
  const section = useRef<HTMLElement>(null);
  useEffect(() => section.current?.focus(), []);
  return (
    <section
      ref={section}
      id={OPEN_HUDDLE}
      tabIndex={-1}
      aria-label={name}
      // Every row the layout has, which on a phone is one more on a page of community settings.
      className="absolute inset-0 z-20 col-start-3 col-end-[-1] row-start-1 row-end-[-1] flex min-h-0 min-w-0 flex-col bg-surface pr-[env(safe-area-inset-right)] outline-none max-md:col-start-1 max-md:pl-[env(safe-area-inset-left)]"
    >
      <header className="flex min-h-header items-center gap-2.5 border-b bg-background py-2.5 pr-3.5 pl-5 max-md:min-h-[calc(56px+env(safe-area-inset-top))] max-md:gap-1.5 max-md:px-2 max-md:pt-[env(safe-area-inset-top)] max-md:pb-0">
        <button type="button" aria-label="Minimize huddle" onClick={minimize} className="hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg max-md:flex">
          <NavArrowDown className="size-[22px]" />
        </button>
        <Headset className="size-5 shrink-0 text-positive max-md:hidden" />
        <h2 className="truncate text-[17px] leading-[1.4] font-[650] max-md:text-base">{name}</h2>
        <span aria-live="polite" className="shrink-0 text-sm text-muted-foreground">
          {waitingToJoin(huddle) ?? (count === 1 ? "1 person" : `${count} people`)}
        </span>
        <button
          type="button"
          title="Minimize huddle"
          aria-label="Minimize huddle"
          onClick={minimize}
          className="ml-auto grid size-9 shrink-0 cursor-pointer place-items-center rounded-[10px] hover:bg-hover touch:size-11 max-md:hidden"
        >
          <Collapse className="size-5" />
        </button>
      </header>

      <div ref={tiles} className="flex min-h-0 min-w-0 flex-1 overflow-auto p-6 max-md:p-3">
        {/* Its margins center it while it fits, and leave its start in reach once it scrolls. */}
        <ul aria-label="In the huddle" className="m-auto grid" style={{ gap: TILE_GAP, gridTemplateColumns: `repeat(${columns}, ${width}px)` }}>
          {huddle.people.map((person) => {
            const you = person.user.id === huddle.you?.id;
            const picture = you ? huddle.camera : (huddle.watched.get(person.user.id) ?? null);
            return <Tile key={person.user.id} person={person} name={nameOf(person.user)} you={you} picture={picture} square={square} />;
          })}
        </ul>
      </div>

      <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t bg-background px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] max-md:flex max-md:justify-between max-md:gap-1.5 max-md:px-2.5">
        <div className="col-start-2 flex gap-1.5">
          <MicrophoneTool huddle={huddle} />
          <CameraTool huddle={huddle} />
        </div>
        <div className="flex justify-end">
          <LeaveButton />
        </div>
      </footer>
    </section>
  );
}

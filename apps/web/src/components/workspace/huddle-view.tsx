import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Room, User, UserId } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { Collapse, Headset, MicrophoneMute, NavArrowDown } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { useIsSpeaking } from "@/hooks/use-huddle";
import { facesAway } from "@/lib/huddle-devices";
import { OPEN_HUDDLE, openHuddle, takeCamerasSmall, type JoinedHuddle } from "@/lib/huddle-store";
import { SCREEN_SHAPE, showsCamerasSmall, stageLayout, TILE_GAP, tilesLayout } from "@/lib/huddle-tiles";
import { cn } from "@/lib/utils";
import { HuddlePicture } from "./huddle-picture";
import { CameraTool, LeaveButton, MicrophoneTool, ScreenTool, SwitchCameraTool, useHuddleName, waitingToJoin } from "./huddle-tools";
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

/**
 * A tile: someone in the huddle, or a screen one of them shares. Its rows keep an avatar in the tile's
 * middle, or, in a tile too short for that, just over what the tile says of it, and an avatar goes by
 * the tile's own size (`cqw`, `cqh`).
 */
const TILE = "relative grid grid-rows-[minmax(6px,1fr)_auto_minmax(44px,1fr)] justify-items-center overflow-hidden rounded-2xl border bg-background [container-type:size]";
/** What a tile says of its picture, over a corner of it. */
const CAPTION = "absolute bottom-2.5 left-2.5 flex max-w-[calc(100%-20px)] items-center gap-1.5 rounded-md bg-surface px-2 py-1 text-[13px] leading-5 font-medium max-md:bottom-1.5 max-md:left-1.5";

interface TileProps {
  person: HuddlePerson;
  name: string;
  /** Whether they're this tab's person, who sees their own camera as a mirror would show it, unless it faces away from them. */
  you: boolean;
  /** Their camera, while it's on and this tab has it to show. */
  picture: MediaStream | null;
  /** The tile's shape, and its size where the tiles' list doesn't give it one. */
  className: string;
}

/**
 * Someone in the huddle: their camera's picture, or their avatar while it's off, over their name, and
 * ringed in green while they speak. The ring is in the tile's edge's place: drawn against each other,
 * the two show a seam between them at the corners.
 */
function Tile({ person, name, you, picture, className }: TileProps) {
  const speaking = useIsSpeaking(person);
  return (
    <li className={cn(TILE, speaking && "border-transparent", className)}>
      {picture ? (
        <HuddlePicture stream={picture} label={you ? "Your camera" : `${name}'s camera`} mirrored={you && !facesAway(picture)} />
      ) : (
        // 96px on a tile at its widest, and smaller with the tile: two fifths of its width, and no taller than its rows leave it over the caption.
        <UserAvatar user={person.user} square className="row-start-2 aspect-square h-auto w-[min(40cqw,96px,calc(100cqh-50px))] rounded-[16%]" />
      )}
      <span className={CAPTION}>
        {person.muted && <MicrophoneMute aria-label="Muted" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">
          {name}
          {you && " (you)"}
        </span>
      </span>
      {/* Last, so over the tile's picture. */}
      {speaking && <span role="img" aria-label="Speaking" className="pointer-events-none absolute inset-0 rounded-[15px] border-2 border-positive" />}
    </li>
  );
}

interface ScreenTileProps {
  /** Whose screen it is, as its caption says. */
  label: string;
  stream: MediaStream;
  /** Shows it large in place of the one that is, which someone else's does at a click. */
  onEnlarge?: () => void;
  className: string;
}

/** A shared screen among the tiles, as small as they are: all of it, over whose it is. */
function ScreenTile({ label, stream, onEnlarge, className }: ScreenTileProps) {
  return (
    <li className={cn(TILE, className)}>
      <HuddlePicture stream={stream} label={label} whole />
      <span className={CAPTION}>
        <span className="truncate">{label}</span>
      </span>
      {onEnlarge && (
        <button
          type="button"
          title={`Show ${label} larger`}
          aria-label={`Show ${label} larger`}
          onClick={onEnlarge}
          className="absolute inset-0 cursor-pointer rounded-2xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
        />
      )}
    </li>
  );
}

interface StageProps {
  /** Whose screen it is, as the line over it says. */
  label: string;
  stream: MediaStream;
  /** Its shape, its width over its height, and how wide it shows. */
  shape: number;
  width: number;
  /** Hears its shape as its picture says it. */
  onShape: (shape: number) => void;
  /** Where it sits in what the tiles leave it. */
  className: string;
}

/**
 * The shared screen a huddle shows large: all of it, in its own shape, under whose it is, where that
 * covers none of it. The line and the space under it are as tall as the layout allows them (`SCREEN_CAPTION`).
 */
function Stage({ label, stream, shape, width, onShape, className }: StageProps) {
  return (
    <figure className={cn("flex shrink-0 flex-col gap-2", className)} style={{ width }}>
      <figcaption className="truncate text-[13px] leading-5 font-medium text-muted-foreground">{label}</figcaption>
      <div className="relative overflow-hidden rounded-2xl border bg-background" style={{ aspectRatio: shape }}>
        <HuddlePicture stream={stream} label={label} whole onShape={onShape} />
      </div>
    </figure>
  );
}

interface TilesProps {
  huddle: JoinedHuddle;
  /** Whose screen shows large, and so not among the tiles. */
  staged: UserId | undefined;
  /** Shows someone else's screen large. */
  onEnlarge: (userId: UserId) => void;
  /** Every tile's shape, and its size where their list doesn't give it one. */
  shape: string;
}

/** A huddle's tiles: the screens shared that don't show large, this tab's own first, then everyone in it. */
function Tiles({ huddle, staged, onEnlarge, shape }: TilesProps) {
  const nameOf = useNameOf();
  return (
    <>
      {huddle.screen && <ScreenTile label="Your screen" stream={huddle.screen} className={shape} />}
      {huddle.people.map(({ user }) => {
        const screen = user.id === staged ? undefined : huddle.screens.get(user.id);
        return screen && <ScreenTile key={user.id} label={screenOf(nameOf(user))} stream={screen} onEnlarge={() => onEnlarge(user.id)} className={shape} />;
      })}
      {huddle.people.map((person) => {
        const you = person.user.id === huddle.you?.id;
        const picture = you ? huddle.camera : (huddle.watched.get(person.user.id) ?? null);
        return <Tile key={person.user.id} person={person} name={nameOf(person.user)} you={you} picture={picture} className={shape} />;
      })}
    </>
  );
}

/** What a screen someone else shares is called. */
const screenOf = (name: string) => `${name}'s screen`;

/** Whose screens the tab has to show, of the others', in the order they joined. */
const sharingIn = (huddle: JoinedHuddle): User[] => huddle.people.filter(({ user }) => huddle.screens.has(user.id)).map(({ user }) => user);

/** A screen's shape, its width over its height, as its picture last said it, and whose screen it is. */
interface Shaped {
  userId: UserId;
  shape: number;
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
 * along its base the microphone, the camera, the screen and Leave, where Slack has them, the first two
 * with an arrow that chooses which microphone, speaker or camera the huddle uses, or on a phone, which
 * has no arrows, a button beside the camera that switches between its cameras. While someone
 * else shares a screen it shows that large, and the tiles in what it leaves them, beside it or under
 * it, as on a phone held upright, whichever shows the screen larger. The screen that shows is the
 * one this tab's person chose among the tiles, while it's shared and the tab has it to show, or else
 * that of whoever joined first. Their own shows among the tiles, as they have the screen itself before
 * them. Minimizing it leaves the huddle's bar under the page.
 */
export function HuddleView({ huddle, room, meId }: Props) {
  const nameOf = useNameOf();
  const name = useHuddleName(room, meId);
  const minimize = () => openHuddle(false);
  const count = huddle.people.length;
  const [tiles, space] = useSpace();
  const [chosen, setChosen] = useState<UserId | null>(null);
  const sharing = sharingIn(huddle);
  const staged = sharing.find(({ id }) => id === chosen) ?? sharing[0];
  const stagedScreen = staged && huddle.screens.get(staged.id);
  // The screen's shape is that of most until its picture says its own.
  const [shaped, setShaped] = useState<Shaped | null>(null);
  const shape = shaped && shaped.userId === staged?.id ? shaped.shape : SCREEN_SHAPE;
  const tileCount = count + (huddle.screen ? 1 : 0) + Math.max(0, sharing.length - 1);
  const stage = staged && stagedScreen ? { user: staged, stream: stagedScreen, ...stageLayout(tileCount, shape, space.width, space.height) } : null;
  const { columns, width, square } = stage?.tiles ?? tilesLayout(tileCount, space.width, space.height);
  // The huddle is sent each camera in the size its tiles show, once it has tiles and knows what size they are, as is the next this tab joins from here.
  const [sized, small] = [tileCount > 0 && space.width > 0, showsCamerasSmall({ width, square })];
  useEffect(() => {
    if (sized) takeCamerasSmall(small);
  }, [sized, small, huddle.roomId]);
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

      <div ref={tiles} className={cn("flex min-h-0 min-w-0 flex-1 p-6 max-md:p-3", stage ? cn("gap-3", !stage.beside && "flex-col") : "overflow-auto")}>
        {stage && (
          <Stage
            label={screenOf(nameOf(stage.user))}
            stream={stage.stream}
            shape={shape}
            width={stage.screen}
            onShape={(shape) => setShaped((last) => (last?.userId === stage.user.id && last.shape === shape ? last : { userId: stage.user.id, shape }))}
            className={stage.beside ? "my-auto ml-auto" : "mx-auto"}
          />
        )}
        {/*
          By themselves, the tiles' margins center them while they fit, and leave their start in reach
          once they scroll. With a screen they scroll by themselves, in rows that stay as tall as their
          tiles, and give way to their scrollbar: beside it, they're in the middle with it while they fit.
        */}
        <ul
          aria-label="In the huddle"
          className={cn("grid auto-rows-max", !stage ? "m-auto" : stage.beside ? "my-auto mr-auto max-h-full overflow-y-auto" : "min-h-0 flex-1 content-start justify-center overflow-y-auto")}
          style={{ gap: TILE_GAP, gridTemplateColumns: `repeat(${columns}, ${stage ? `minmax(0, ${width}px)` : `${width}px`})` }}
        >
          <Tiles huddle={huddle} staged={stage?.user.id} onEnlarge={setChosen} shape={square ? "aspect-square" : "aspect-[4/3]"} />
        </ul>
      </div>

      <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t bg-background px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] max-md:flex max-md:justify-between max-md:gap-1.5 max-md:px-2.5">
        <div className="col-start-2 flex gap-1.5">
          <MicrophoneTool huddle={huddle} devices />
          <CameraTool huddle={huddle} devices />
          <SwitchCameraTool huddle={huddle} />
          <ScreenTool huddle={huddle} />
        </div>
        <div className="flex justify-end">
          <LeaveButton />
        </div>
      </footer>
    </section>
  );
}

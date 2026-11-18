import { lazy, Suspense, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HUDDLE_STICKERS, type HuddleSticker } from "@ember/protocol/huddles";
import { CheckCircle, NavArrowUp } from "@/components/icons/iconoir";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useMediaQuery } from "@/hooks/use-media-query";
import { reactInHuddle, showHuddleSticker, type JoinedHuddle } from "@/lib/huddle-store";
import { STICKERS } from "@/lib/huddle-stickers";
import { hasTouchKeyboard } from "@/lib/keyboard";
import { cn } from "@/lib/utils";

// What someone in a huddle shows the others besides their camera and their screen: a sticker, which
// stays on their tile until they take it off, and reactions, each an emoji that rises over the people
// in the huddle for a moment. Slack's huddles have both: the stickers under the arrow beside Raise
// hand, and the reactions in the panel its emoji button opens, which here has a tab for the stickers
// too, for the phones that have no arrow.

const EmojiPanel = lazy(() => import("./emoji-panel"));

interface MenuProps {
  huddle: JoinedHuddle;
  /** The arrow's look, which is its button's. */
  className: string;
}

/**
 * The arrow beside Raise hand, and the menu it opens over the huddle's base: the stickers there are,
 * under how long one stays, as Slack's says, the one the tab's person shows ticked, which choosing it
 * again takes off.
 */
export function StickersMenu({ huddle, className }: MenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger title="Stickers" aria-label="Stickers" className={className}>
        <NavArrowUp />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" sideOffset={8} className="min-w-[200px]">
        <DropdownMenuLabel>
          Stickers
          <span className="block text-[13px] font-normal text-muted-foreground">One stays on until you take it off.</span>
        </DropdownMenuLabel>
        {HUDDLE_STICKERS.map((sticker) => (
          <DropdownMenuCheckboxItem key={sticker} checked={sticker === huddle.sticker} onCheckedChange={(shown) => showHuddleSticker(shown ? sticker : null)}>
            <span aria-hidden className="text-base leading-none">
              {STICKERS[sticker].emoji}
            </span>
            {STICKERS[sticker].name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TABS = ["Reactions", "Stickers"] as const;
type Tab = (typeof TABS)[number];

/** A screen too short for the panel's tabs over what they hold, as a phone's held on its side, and wide enough for them beside it. */
const TABS_BESIDE = "(height < 31.25rem) and (width >= 30rem)";

interface StickersProps {
  /** The one the tab's person shows, which is marked. */
  shown: HuddleSticker | null;
  onChoose: (sticker: HuddleSticker | null) => void;
}

/**
 * The stickers there are, each to show in place of any that's shown, and the one that's shown to take
 * off. They're over the emoji picker, in its place, and scroll where it's too short for them all.
 */
function Stickers({ shown, onChoose }: StickersProps) {
  return (
    <ul className="absolute inset-0 flex flex-col gap-0.5 overflow-y-auto p-2">
      {HUDDLE_STICKERS.map((sticker) => (
        <li key={sticker}>
          <button
            type="button"
            aria-pressed={sticker === shown}
            onClick={() => onChoose(sticker === shown ? null : sticker)}
            className="group flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-start text-[15px] hover:bg-hover aria-pressed:bg-hover aria-pressed:font-semibold"
          >
            <span aria-hidden className="text-[22px] leading-none">
              {STICKERS[sticker].emoji}
            </span>
            {STICKERS[sticker].name}
            <CheckCircle className="ms-auto size-[18px] flex-none opacity-0 group-aria-pressed:opacity-100" />
          </button>
        </li>
      ))}
    </ul>
  );
}

interface PanelProps {
  huddle: JoinedHuddle;
  /** Whether its tabs are beside what they hold, rather than over it. */
  beside: boolean;
  /** Closes the panel, as choosing a sticker or a reaction does. */
  onClose: () => void;
}

/**
 * What the panel holds, a tab for each: Reactions, the emoji picker, where an emoji picked is sent as
 * a reaction and closes the panel, as Slack's does, which shows the reaction rise where the panel was,
 * and Stickers. It opens on Reactions, with the cursor in the picker's search, to type in at once. A
 * touch screen is a phone's as a rule, where the panel covers the people in the huddle: there the
 * search is left alone, since the cursor in it would bring the keyboard up over them too. The picker
 * stays under Stickers, unseen, so that the panel is as large on either tab, and the picker is as it
 * was left. Where the panel has less room than the picker would take, the picker is as tall as the
 * room there is.
 */
function Panel({ huddle, beside, onClose }: PanelProps) {
  const id = useId();
  const [tab, setTab] = useState<Tab>("Reactions");
  const touch = hasTouchKeyboard();
  // As a tablist's arrows do, choosing the tab they move to, across the top or down the side.
  const moveBetweenTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
    else return;
    event.preventDefault();
    tabs[next]!.focus();
    setTab(TABS[next]!);
  };
  const react = (emoji: string) => {
    reactInHuddle(emoji);
    onClose();
  };
  const choose = (sticker: HuddleSticker | null) => {
    showHuddleSticker(sticker);
    onClose();
  };
  return (
    <>
      <div
        role="tablist"
        aria-label="Reactions and stickers"
        aria-orientation={beside ? "vertical" : "horizontal"}
        onKeyDown={moveBetweenTabs}
        // Down the side they're as wide whichever is chosen, though the one that is has heavier letters.
        className={cn("m-2 flex flex-none gap-1 rounded-[9px] border bg-surface p-1", beside && "w-28 flex-col self-start")}
      >
        {TABS.map((name) => (
          <button
            key={name}
            id={`${id}-${name}`}
            type="button"
            role="tab"
            aria-selected={name === tab}
            aria-controls={`${id}-panel`}
            tabIndex={name === tab ? 0 : -1}
            onClick={() => setTab(name)}
            className="min-h-9 flex-1 cursor-pointer rounded-md border border-transparent px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground aria-selected:border-border aria-selected:bg-background aria-selected:font-semibold aria-selected:text-foreground aria-selected:shadow-xs touch:min-h-11"
          >
            {name}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={cn("relative flex min-h-0 flex-col", beside ? "border-s" : "border-t")}>
        <div className={cn("flex min-h-0 flex-col", tab !== "Reactions" && "invisible")}>
          <Suspense
            fallback={
              <div className="flex h-[min(380px,60dvh)] w-[300px] items-center justify-center text-muted-foreground">
                <span className="spinner ps-[1.5em]">
                  <span className="sr-only">Loading emoji…</span>
                </span>
              </div>
            }
          >
            <EmojiPanel onPick={react} autoFocus={!touch} />
          </Suspense>
        </div>
        {tab === "Stickers" && <Stickers shown={huddle.sticker} onChoose={choose} />}
      </div>
    </>
  );
}

interface Props {
  huddle: JoinedHuddle;
  /** What's between the huddle's header and its buttons, which the panel is no taller than. */
  within: HTMLElement | null;
  /**
   * The huddle's buttons, React among them, which the panel opens over. They're given what opens it
   * from another of them, which has the focus back as it closes: More, whose menu has React on a phone
   * too narrow to give it a button.
   */
  children: (react: (opener: HTMLElement) => void) => ReactNode;
}

/**
 * How far the panel keeps from the edges of what it's within. Its buttons, in the huddle's footer, hold
 * it 5px past the bottom edge, which counts against its room, so 3px from the top edge leave it 8px
 * under the huddle's header, as it's 8px over its buttons.
 */
const MARGINS = { top: 3, right: 8, bottom: 0, left: 8 };

/**
 * The huddle's buttons, and the panel React opens over them, as Slack's emoji button does: the
 * reactions to send, and the stickers to show. It starts where the buttons do, which keeps it as clear
 * of the notch of a phone on its side as they are, and it stops short of the huddle's header, with its
 * tabs beside what they hold on a screen too short for them over it. Escape closes it, and so does a
 * click outside it, React again, or choosing a sticker or a reaction.
 */
export function HuddleReactions({ huddle, within, children }: Props) {
  const beside = useMediaQuery(TABS_BESIDE);
  const [open, setOpen] = useState(false);
  /** The button it was opened from, where that isn't React. */
  const opener = useRef<HTMLElement | null>(null);
  /** Whether it's closing at a click or a Tab outside it, which leaves the focus where that put it. */
  const leaving = useRef(false);
  const openFrom = (button: HTMLElement) => {
    opener.current = button;
    setOpen(true);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{children(openFrom)}</PopoverAnchor>
      <PopoverContent
        aria-label="React"
        side="top"
        align="start"
        sideOffset={8}
        collisionBoundary={within}
        collisionPadding={MARGINS}
        className={cn("flex max-h-(--radix-popover-content-available-height) w-fit overflow-hidden rounded-[12px] p-0", beside ? "flex-row" : "flex-col")}
        onInteractOutside={() => void (leaving.current = true)}
        onCloseAutoFocus={(event) => {
          if (opener.current && !leaving.current) {
            event.preventDefault();
            opener.current.focus();
          }
          opener.current = null;
          leaving.current = false;
        }}
      >
        <Panel huddle={huddle} beside={beside} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

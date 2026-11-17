import { lazy, Suspense, useRef, useState } from "react";
import { Emoji } from "@/components/icons/iconoir";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ShortcutTooltip } from "./shortcut-tooltip";

const EmojiPanel = lazy(() => import("./emoji-panel"));

/** The picker's size, which it keeps while it loads. */
const PANEL = "h-[min(380px,60dvh)] w-[300px]";

interface Props {
  disabled: boolean;
  className: string;
  /** Writes the emoji picked where the cursor is in the text. */
  onPick: (emoji: string) => void;
  /** Puts focus back in the text once the picker's closed, unless a click or Tab outside it put focus elsewhere. */
  onClosed: () => void;
}

/** Slack's Emoji, under the composer's text: the emoji picker, over the button, which closes as an emoji's picked. */
export function EmojiButton({ disabled, className, onPick, onClosed }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Whether the picker's closing as you click or tab outside it, where focus is left. Its own button closes it as
  // Escape does.
  const leaving = useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ShortcutTooltip label="Emoji" hidden={open}>
        <PopoverTrigger asChild>
          <button ref={button} type="button" aria-label="Emoji" disabled={disabled} className={className}>
            <Emoji className="size-[18px] opacity-70" />
          </button>
        </PopoverTrigger>
      </ShortcutTooltip>
      <PopoverContent
        aria-label="Emoji"
        side="top"
        align="start"
        sideOffset={8}
        className="w-fit overflow-hidden rounded-[12px] p-0"
        onInteractOutside={(event) => {
          leaving.current = !button.current?.contains(event.target as Node);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!leaving.current) onClosed();
          leaving.current = false;
        }}
      >
        <Suspense
          fallback={
            <div className={`${PANEL} flex items-center justify-center text-muted-foreground`}>
              <span className="spinner ps-[1.5em]">
                <span className="sr-only">Loading emoji…</span>
              </span>
            </div>
          }
        >
          <EmojiPanel
            onPick={(emoji) => {
              onPick(emoji);
              setOpen(false);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

import { ArrowLeft, ArrowRight } from "@/components/icons/iconoir";
import { useCanGoBack, useCanGoForward } from "@/hooks/use-route";
import { backShortcut, forwardShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** One of the arrows: a 28px square in the rail's muted ink, which a pointer highlights, faint while it has nowhere to go. */
const ARROW = "grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/**
 * Back and Forward, as Slack's top bar has them, each with the keys the browser takes for it in its
 * tooltip. They step through the pages the app has shown in this tab, as the browser's own buttons do,
 * but never out of Ember: Back is faint on the first page it showed, and Forward until Back is pressed.
 */
export function HistoryButtons({ className }: { className?: string }) {
  const back = useCanGoBack();
  const forward = useCanGoForward();
  return (
    <div className={cn("flex shrink-0 gap-0.5", className)}>
      <ShortcutTooltip label="Back" shortcut={backShortcut()}>
        <button type="button" aria-label="Back" disabled={!back} onClick={() => history.back()} className={ARROW}>
          <ArrowLeft className="size-5" />
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Forward" shortcut={forwardShortcut()}>
        <button type="button" aria-label="Forward" disabled={!forward} onClick={() => history.forward()} className={ARROW}>
          <ArrowRight className="size-5" />
        </button>
      </ShortcutTooltip>
    </div>
  );
}

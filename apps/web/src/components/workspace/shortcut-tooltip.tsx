import { useState, type ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Shortcut } from "@/lib/keyboard";

interface Props {
  label: string;
  /** The keys that do what the button does, if any do. */
  shortcut?: Shortcut;
  /** Keeps it closed, as while the menu or picker its button opens is open. */
  hidden?: boolean;
  children: ReactElement;
}

/**
 * Names a button, and the keys that do what it does, in a tooltip the moment the pointer reaches it, and
 * tells screen readers the keys. Focus doesn't open it, so the button a dialog gives focus back to isn't
 * left with it showing.
 */
export function ShortcutTooltip({ label, shortcut, hidden = false, children }: Props) {
  const [open, setOpen] = useState(false);
  return (
    // Pressing the button closes it, but a quick press can come before its delay is up, when it would open over
    // the menu the press opened and take the Escape meant for the menu. While hidden, it stays closed.
    <Tooltip disableHoverableContent open={open && !hidden} onOpenChange={(next) => setOpen(next && !hidden)}>
      <TooltipTrigger asChild aria-keyshortcuts={shortcut?.aria} onFocus={(event) => event.preventDefault()}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {shortcut && (
          <span aria-hidden className="flex gap-0.5">
            {shortcut.keys.map((key) => (
              <kbd key={key} className="grid min-w-[18px] place-items-center rounded-[4px] bg-background/20 px-1 font-sans text-[11px] leading-[18px]">
                {key}
              </kbd>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

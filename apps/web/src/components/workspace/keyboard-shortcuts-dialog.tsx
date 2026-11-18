import { useRef } from "react";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { appleKeyboard, SHORTCUTS } from "@/lib/keyboard";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The keyboard shortcuts, a group at a time, each with its keys as this keyboard names them: Cmd and
 * Option on a Mac, iPad or iPhone, Ctrl and Alt elsewhere. Cmd+/ or Ctrl+/ opens it,
 * and Escape or its × closes it, handing focus back to where it was.
 */
export function KeyboardShortcutsDialog({ open, onOpenChange }: Props) {
  const apple = appleKeyboard();
  // What had the focus when a key opened it, which has no trigger of its own for Radix to give it back to.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus({ preventScroll: true });
          opener.current = null;
        }}
        className={DIALOG}
      >
        <button type="button" aria-label="Close" onClick={() => onOpenChange(false)} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle className={DIALOG_TITLE}>Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">The keys that do what Ember does, and what each does.</DialogDescription>
        {SHORTCUTS.map(({ group, rows }) => (
          <section key={group} aria-label={group} className="mt-5">
            <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{group}</h3>
            <dl className="flex flex-col">
              {rows.map(({ action, keys }) => (
                <div key={action} className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0">
                  <dt>{action}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {keys(apple).map((key) => (
                      <kbd key={key} className="grid h-6 min-w-6 place-items-center rounded-[5px] border border-border bg-surface px-1.5 font-sans text-xs text-muted-foreground">
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}

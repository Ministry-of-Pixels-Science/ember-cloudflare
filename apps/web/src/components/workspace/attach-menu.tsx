import { useRef, useState, type ComponentType } from "react";
import { CodeBrackets, Plus, Upload, Xmark, type IconoirIconProps } from "@/components/icons/iconoir";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { appleKeyboard, snippetShortcut, uploadShortcut, type Shortcut } from "@/lib/keyboard";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** What the menu closed for, which says where focus goes as it does. */
type Choice = "upload" | "snippet";

interface Props {
  disabled: boolean;
  className: string;
  /** Opens the browser's file picker, which it does only in the press itself. */
  onUpload: () => void;
  /** Opens Text snippet's dialog, once the menu's gone. */
  onSnippet: () => void;
  /** Puts focus back in the text once the menu's gone, but for a snippet. */
  onClosed: () => void;
}

/**
 * Slack's +, under the composer's text: a menu of Text snippet and Upload from your computer, Slack's two that
 * Ember has, each with its keys. The + is an × while it's open.
 */
export function AttachMenu({ disabled, className, onUpload, onSnippet, onClosed }: Props) {
  const [open, setOpen] = useState(false);
  const chosen = useRef<Choice>(null);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ShortcutTooltip label="Attach" hidden={open}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Attach" disabled={disabled} className={className}>
            {open ? <Xmark className="size-[18px]" /> : <Plus className="size-[18px]" />}
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        // The snippet's dialog opens once the menu has closed, so the menu doesn't hand focus back over it.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const choice = chosen.current;
          chosen.current = null;
          if (choice === "snippet") onSnippet();
          else onClosed();
        }}
      >
        <Item icon={CodeBrackets} label="Text snippet" shortcut={snippetShortcut()} onSelect={() => (chosen.current = "snippet")} />
        <Item
          icon={Upload}
          label="Upload from your computer"
          shortcut={uploadShortcut()}
          onSelect={() => {
            chosen.current = "upload";
            onUpload();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ItemProps {
  icon: ComponentType<IconoirIconProps>;
  label: string;
  shortcut: Shortcut;
  onSelect: () => void;
}

/** One of the menu's items, with its keys after it, as Slack's menu shows them. */
function Item({ icon: Icon, label, shortcut, onSelect }: ItemProps) {
  return (
    <DropdownMenuItem onSelect={onSelect} aria-keyshortcuts={shortcut.aria} className="min-w-64 gap-2.5">
      <Icon className="size-[18px]" />
      {label}
      <span aria-hidden className="ms-auto ps-6 text-xs text-muted-foreground">
        {shortcut.keys.join(appleKeyboard() ? "" : "+")}
      </span>
    </DropdownMenuItem>
  );
}

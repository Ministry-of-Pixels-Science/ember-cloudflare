import { useId, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type RefObject } from "react";
import { FIELD_INPUT, Field } from "@/components/field";
import {
  Bold,
  Code,
  CodeBracketsSquare,
  HSquare,
  Italic,
  Link,
  List,
  Minus,
  NavArrowDown,
  NumberedListLeft,
  Quote,
  Strikethrough,
  Underline,
  type IconoirIconProps,
} from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { FORMATTING_NAMES, HEADING_TAGS, linkAddress, NOT_IN_CODE_BLOCKS, PLAIN_TEXT, type FormattingCommand, type FormattingKey, type LinkDraft, type TextFormat } from "@/lib/formatting";
import { formattingKeys, formattingShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import type { RichTextEditorHandle } from "./editor";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { DIALOG, DIALOG_BACKDROP, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Slack's formatting row, over a message's text in the composer and the edit form, with its Paragraph menu
// and Link's dialog, and the keys that do what its buttons do, which work whether the row shows or not.

/** What Link's dialog edits, and which time it opened, so each opening starts afresh. */
interface Linking {
  draft: LinkDraft;
  opening: number;
}

/**
 * The formatting where the cursor is in an editor's text, which its `onFormatChange` keeps, and Link's
 * dialog, for a formatting row, a `LinkDialog` and the formatting keys pressed in the text.
 */
export function useFormatting(editor: RefObject<RichTextEditorHandle | null>) {
  const [format, setFormat] = useState<TextFormat>(PLAIN_TEXT);
  const [linking, setLinking] = useState<Linking | null>(null);
  const openings = useRef(0);

  /** Whether the row greys `action` out where the cursor is, as Slack's does in a code block. */
  const disabled = (action: FormattingKey) => format.codeBlock && NOT_IN_CODE_BLOCKS.has(action);

  const openLink = () => {
    const draft = editor.current?.linkDraft();
    if (draft) setLinking({ draft, opening: ++openings.current });
  };

  /** Takes a key pressed in the text that formats it, answering whether it was one, for the editor's `onKeyDown`. */
  const keyDown = (event: KeyboardEvent): boolean => {
    const action = formattingShortcut(event);
    if (!action) return false;
    event.preventDefault();
    event.stopPropagation();
    if (disabled(action)) return true;
    editor.current?.catchUp();
    if (action === "link") openLink();
    else editor.current?.apply(action);
    return true;
  };

  return { editor, format, setFormat, disabled, linking, openLink, closeLink: () => setLinking(null), keyDown };
}

export type Formatting = ReturnType<typeof useFormatting>;

/** A button of the row: the composer's buttons' size, darkening on hover, and lit while its formatting's on. */
const TOOL = cn(
  "group/tool flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center gap-px rounded-[7px] touch:h-11 touch:min-w-11",
  "[@media(hover:hover)_and_(pointer:fine)]:enabled:hover:bg-hover aria-pressed:bg-hover aria-expanded:bg-hover",
  "disabled:cursor-default disabled:opacity-40",
);

const ICON = "size-[18px] opacity-70 group-aria-pressed/tool:opacity-100";

interface ToolProps {
  action: FormattingKey;
  icon: ComponentType<IconoirIconProps>;
  /** Whether its formatting is on where the cursor is, for a button that turns it on or off. */
  pressed?: boolean;
  disabled: boolean;
  /** Whether it's the row's one button in the tab order. */
  tabbable: boolean;
  onFocus: () => void;
  onPress: (event: MouseEvent) => void;
}

/** A button of the row, named in a tooltip with its keys, which keeps focus in the text as it's pressed. */
function Tool({ action, icon: Icon, pressed, disabled, tabbable, onFocus, onPress }: ToolProps) {
  return (
    <ShortcutTooltip label={FORMATTING_NAMES[action]} shortcut={formattingKeys(action)}>
      <button
        type="button"
        aria-label={FORMATTING_NAMES[action]}
        aria-pressed={pressed}
        disabled={disabled}
        tabIndex={tabbable ? 0 : -1}
        data-action={action}
        onMouseDown={(event) => event.preventDefault()}
        onFocus={onFocus}
        onClick={onPress}
        className={TOOL}
      >
        <Icon className={ICON} />
      </button>
    </ShortcutTooltip>
  );
}

/** Where Slack's row parts its groups of buttons. */
function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border touch:h-6" />;
}

/** The styles Paragraph offers, in Slack's order. */
const STYLES = ["paragraph", ...HEADING_TAGS] as const;

interface ToolbarProps {
  formatting: Formatting;
  className?: string;
}

/**
 * Slack's formatting row: Bold, Italic, Underline, Strikethrough and the Paragraph menu; Link, Ordered and
 * Bulleted list; Blockquote, Code, Code block and Divider. Each is lit while its formatting is on where the
 * cursor is, and those a code block has no use for grey out in one. A click formats and leaves focus in
 * the text; the row is one stop in the tab order, whose arrow keys move along it, Enter or Space format
 * and leave focus on the button for the next, and Escape goes back to the text.
 */
export function FormattingToolbar({ formatting, className }: ToolbarProps) {
  const { editor, format, disabled, openLink } = formatting;
  const row = useRef<HTMLDivElement>(null);
  // The button last focused, which is the row's stop in the tab order unless it's greyed out.
  const [current, setCurrent] = useState<FormattingKey>("bold");
  const tabStop = disabled(current) ? "paragraph" : current;

  const press = (event: MouseEvent, command: FormattingCommand) => {
    // A click keeps focus in the text, or puts it back there to format what's selected in it.
    if (event.detail > 0) editor.current?.focus();
    editor.current?.apply(command);
  };

  const tool = (action: FormattingCommand | "link", icon: ToolProps["icon"], pressed?: boolean) => (
    <Tool
      action={action}
      icon={icon}
      pressed={pressed}
      disabled={disabled(action)}
      tabbable={tabStop === action}
      onFocus={() => setCurrent(action)}
      onPress={(event) => (action === "link" ? openLink() : press(event, action))}
    />
  );

  const move = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      // Kept from the edit form, which Escape would close.
      event.stopPropagation();
      editor.current?.focus();
      return;
    }
    const buttons = [...row.current!.querySelectorAll<HTMLButtonElement>("button:enabled")];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (at < 0 || to === undefined) return;
    event.preventDefault();
    buttons[(to + buttons.length) % buttons.length]!.focus();
  };

  return (
    <div ref={row} role="toolbar" aria-label="Formatting" onKeyDown={move} className={cn("flex min-w-0 flex-wrap items-center gap-0.5", className)}>
      {tool("bold", Bold, format.bold)}
      {tool("italic", Italic, format.italic)}
      {tool("underline", Underline, format.underline)}
      {tool("strikethrough", Strikethrough, format.strikethrough)}
      <ParagraphMenu formatting={formatting} tabbable={tabStop === "paragraph"} onFocus={() => setCurrent("paragraph")} />
      <Divider />
      {tool("link", Link, format.link)}
      {tool("orderedList", NumberedListLeft, format.list === "ordered")}
      {tool("bulletedList", List, format.list === "bulleted")}
      <Divider />
      {tool("quote", Quote, format.quote)}
      {tool("code", Code, format.code)}
      {tool("codeBlock", CodeBracketsSquare, format.codeBlock)}
      {tool("divider", Minus)}
    </div>
  );
}

interface ParagraphMenuProps {
  formatting: Formatting;
  tabbable: boolean;
  onFocus: () => void;
}

/**
 * Slack's Paragraph menu: Paragraph, and Big, Medium and Small heading, each marked H1 to H3 as Slack marks
 * them, with the line's style ticked. Picking one formats the line, or the lines selected, and puts focus
 * back in the text.
 */
function ParagraphMenu({ formatting, tabbable, onFocus }: ParagraphMenuProps) {
  const { editor, format } = formatting;
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ShortcutTooltip label={FORMATTING_NAMES.paragraph} hidden={open}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={FORMATTING_NAMES.paragraph}
            tabIndex={tabbable ? 0 : -1}
            data-action="paragraph"
            onMouseDown={(event) => event.preventDefault()}
            onFocus={onFocus}
            className={cn(TOOL, "px-1")}
          >
            <HSquare className={ICON} />
            <NavArrowDown className="size-3 opacity-70" />
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        align="start"
        // Kept from the edit form, which Escape would close.
        onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.current?.focus();
        }}
      >
        <DropdownMenuRadioGroup value={format.heading ?? "paragraph"} onValueChange={(style) => editor.current?.apply(style as FormattingCommand)}>
          {STYLES.map((style) => (
            <DropdownMenuRadioItem key={style} value={style} className="min-w-48">
              {FORMATTING_NAMES[style]}
              {style !== "paragraph" && <span className="ms-auto ps-6 text-xs text-muted-foreground">{style.toUpperCase()}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Link's dialog, as Slack's: the text to link, which starts as what's selected, or as the link's where the
 * cursor is in one, and the address, where one without a scheme is taken as a web address. Save links the
 * text, Remove link takes a link off, and either puts focus back in the text, as Cancel and Escape do.
 */
export function LinkDialog({ formatting }: { formatting: Formatting }) {
  const { editor, linking, closeLink } = formatting;
  // What it shows, kept as it closes, so it doesn't empty as it fades.
  const [shown, setShown] = useState(linking);
  if (linking && linking !== shown) setShown(linking);
  // Save and Remove link change the text at once, so that it's changed even before focus is back in it,
  // where the change put the cursor, as the dialog fades, and only once, though Enter's pressed again.
  const finish = (changeText: () => void) => {
    if (linking === null) return;
    changeText();
    closeLink();
  };

  return (
    <Dialog open={linking !== null} onOpenChange={(open) => !open && closeLink()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.current?.focus();
        }}
        className={DIALOG}
      >
        {shown && (
          <LinkForm
            key={shown.opening}
            draft={shown.draft}
            onSave={(draft) => finish(() => editor.current?.link(draft))}
            onRemove={() => finish(() => editor.current?.unlink())}
            onCancel={closeLink}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface LinkFormProps {
  draft: LinkDraft;
  onSave: (draft: LinkDraft) => void;
  onRemove: () => void;
  onCancel: () => void;
}

function LinkForm({ draft, onSave, onRemove, onCancel }: LinkFormProps) {
  const [text, setText] = useState(draft.text);
  const [url, setUrl] = useState(draft.url);
  const id = useId();
  const editing = draft.url !== "";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (url.trim() === "") return;
        const address = linkAddress(url);
        onSave({ text: text.trim() === "" ? address : text, url: address });
      }}
    >
      <DialogTitle className={DIALOG_TITLE}>{editing ? "Edit link" : "Add link"}</DialogTitle>
      <DialogDescription className="sr-only">The text to link, and the address it goes to.</DialogDescription>
      <div className="mt-4 flex flex-col gap-4">
        <Field id={`${id}-text`} label="Text">
          <Input id={`${id}-text`} value={text} autoFocus={draft.text === ""} autoComplete="off" onChange={(event) => setText(event.target.value)} className={FIELD_INPUT} />
        </Field>
        <Field id={`${id}-link`} label="Link">
          <Input
            id={`${id}-link`}
            value={url}
            autoFocus={draft.text !== ""}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
            className={FIELD_INPUT}
          />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
        {editing && (
          <button type="button" onClick={onRemove} className={cn(OTHER_ACTION, "me-auto")}>
            Remove link
          </button>
        )}
        <button type="button" onClick={onCancel} className={OTHER_ACTION}>
          Cancel
        </button>
        <button type="submit" disabled={url.trim() === ""} className={MAIN_ACTION}>
          Save
        </button>
      </div>
    </form>
  );
}

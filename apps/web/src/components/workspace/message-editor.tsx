import { Suspense, useContext, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import type { Message } from "@ember/protocol";
import { editableBody } from "@ember/richtext/dom";
import { CheckCircle, Trash, Xmark } from "@/components/icons/iconoir";
import { DirectoryLoaded, mentionedPerson, PeopleContext } from "@/hooks/use-directory";
import { useScrollIntoView } from "@/hooks/use-scroll-into-view";
import { mentionPromptSrc } from "@/lib/api";
import { pressedAlone, savesEdit } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { RichTextEditor, type RichTextEditorHandle } from "./editor";
import { FormattingToolbar, LinkDialog, useFormatting } from "./formatting-toolbar";
import { avatarUrlOf } from "./user-avatar";

/**
 * Campfire's round icon buttons (buttons.css), as the edit form's are: 36px, or 44px on touch screens,
 * with the icon at 1.3em, darkening on hover as `.btn--reversed` and `.btn--negative` do.
 */
const ROUND_BUTTON = "grid size-9 shrink-0 cursor-pointer place-items-center rounded-full touch:size-11 hover:not-active:brightness-70";

interface Props {
  message: Message;
  /** Saves the message as written, answering whether the change went: one that didn't stays to be tried again. */
  onSave: (body: string) => boolean;
  onDelete: () => void;
  /** Closes the editor, discarding what's written in it. */
  onClose: () => void;
  ref?: Ref<MessageEditorHandle>;
}

export interface MessageEditorHandle {
  /** Focuses the text, keeping what's written in it, or a file message's Delete message. */
  focus(): void;
}

/**
 * The edit form (Campfire's composer.css and messages.css), in the message's place: a card holding the
 * text in Lexxy, with the composer's formatting row above the text on wide screens with a mouse, ruled
 * off from it across the field, and round Save changes and Delete message buttons under it, beside a
 * button that closes it. Ctrl or Cmd+Enter saves, Escape closes it, and Enter starts a new paragraph.
 * The formatting keys format, as they do in the composer, and @ offers the room's people, as its @ does.
 * It takes no files and tells no one you're typing.
 */
export function MessageEditor({ message, onSave, onDelete, onClose, ref }: Props) {
  const editor = useRef<RichTextEditorHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const formatting = useFormatting(editor);
  const people = useContext(PeopleContext);
  // The editable body: its mentions as the editor draws them, of the people as they are now, and its link previews
  // as the message shows them here. It drops a mention of no one, and a message from before messages named the
  // people they mention knows them only from the directory, so for such a message the editor waits for the
  // directory to load, when it lists everyone.
  const knowsMentions = useContext(DirectoryLoaded) || message.mentions.every((person) => person.name !== "");
  const editableNow = () =>
    editableBody(
      message.body,
      (userId) => {
        const person = mentionedPerson(people, message.mentions, userId);
        return person && { id: person.id, name: person.name, avatarUrl: avatarUrlOf(people, person) };
      },
      location.hostname,
    );
  const [editable, setEditable] = useState(() => (knowsMentions ? editableNow() : null));
  if (editable === null && knowsMentions) setEditable(editableNow());

  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);
  useScrollIntoView(container);

  const loading = <div className="min-h-6" />;

  const save = () => {
    const written = editor.current;
    // Saving a message left blank or as it was only closes the editor. An edit that couldn't be sent
    // keeps it open, so what was written isn't lost. Lexxy writes mentions with their content, so a
    // message with them is sent as it was, which the room keeps as it is.
    if (written && !written.isBlank() && written.value() !== message.body && !onSave(written.value())) return;
    onClose();
  };

  return (
    // The card and the close button sit half a character apart, and the close button as far from the
    // message's edge.
    <div ref={container} className="col-start-2 flex min-w-0 gap-x-[0.5ch] py-1 pr-[0.5ch] text-sm">
      <div className="message-edit min-w-0 flex-1 rounded-[10px] border bg-surface p-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          onKeyDownCapture={(event) => {
            // Taken before the editor sees it, unless a list the editor has open, such as the people to
            // mention, would take it, as such a list closes as it takes it.
            if (!savesEdit(event.nativeEvent) || editor.current?.hasOpenPrompt()) return;
            event.preventDefault();
            event.stopPropagation();
            save();
          }}
          onKeyDown={(event) => {
            // Lexxy's menus and lists close on Escape themselves, and keep it from here.
            if (pressedAlone(event.nativeEvent, "Escape")) onClose();
          }}
        >
          <div className="rounded-[9px] border bg-background px-[0.8em] py-[0.5em] text-base transition-shadow duration-150 focus-within:ring-2 focus-within:ring-selected-dark">
            <FormattingToolbar
              formatting={formatting}
              className="-mx-[0.8em] mb-2 hidden border-b px-[0.3em] pb-[0.5em] [@media(min-width:100ch)_and_(any-hover:hover)_and_(pointer:fine)]:flex"
            />
            {/* The composer has loaded the editor by the time a message can be edited. */}
            <Suspense fallback={loading}>
              {editable === null ? (
                loading
              ) : (
                <RichTextEditor
                  ref={editor}
                  label="Edit message"
                  rows={1}
                  initialValue={editable}
                  mentionsFrom={mentionPromptSrc(message.roomId)}
                  autoFocus
                  onFormatChange={formatting.setFormat}
                  onKeyDown={formatting.keyDown}
                />
              )}
            </Suspense>
          </div>
          <div className="flex items-center justify-between pt-2">
            <button type="submit" className={cn(ROUND_BUTTON, "bg-foreground text-background")}>
              <CheckCircle className="size-[1.3em]" />
              <span className="sr-only">Save changes</span>
            </button>
            <DeleteButton onDelete={onDelete} />
          </div>
        </form>
        {/* Outside the form, whose Escape would close the editor, and whose Ctrl or Cmd+Enter would save it. */}
        <LinkDialog formatting={formatting} />
      </div>
      <CloseButton onClose={onClose} />
    </div>
  );
}

interface FixedMessageEditorProps {
  /** The message as it shows. */
  children: ReactNode;
  onDelete: () => void;
  onClose: () => void;
  ref?: Ref<MessageEditorHandle>;
}

/**
 * The edit form for a file message, whose text can't be edited: the message as it shows, its file, with
 * Delete message centered under it, beside the button that closes it. A message with cards, whose text
 * the room won't change, opens it too. It focuses Delete message as it opens, as the text editor focuses
 * the text, and Escape closes it, as the text editor's form does. Delete message asks first.
 */
export function FixedMessageEditor({ children, onDelete, onClose, ref }: FixedMessageEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => deleteButton.current?.focus() }), []);
  useScrollIntoView(container);

  return (
    <div
      ref={container}
      className="col-start-2 flex min-w-0 gap-x-[0.5ch] py-1 pr-[0.5ch] text-sm"
      onKeyDown={(event) => {
        if (pressedAlone(event.nativeEvent, "Escape")) onClose();
      }}
    >
      <div className="min-w-0 flex-1">
        {children}
        <div className="flex justify-center pt-2">
          <DeleteButton ref={deleteButton} onDelete={onDelete} className="mb-4" autoFocus />
        </div>
      </div>
      <CloseButton onClose={onClose} />
    </div>
  );
}

/** Delete message, a round red button that asks before it deletes, as `data-turbo-confirm` does. */
function DeleteButton({ onDelete, className, autoFocus, ref }: { onDelete: () => void; className?: string; autoFocus?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      autoFocus={autoFocus}
      className={cn(ROUND_BUTTON, "bg-negative-button text-white", className)}
      onClick={() => confirm("Are you sure you want to delete this message?") && onDelete()}
    >
      <Trash className="size-[1.3em]" />
      <span className="sr-only">Delete message</span>
    </button>
  );
}

/** `.message__actions`, which centers its button, Close editor and discard changes, against the editor. */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={onClose}
        className="grid size-9 cursor-pointer place-items-center rounded-full text-[0.8rem] touch:size-11 [@media(hover:hover)_and_(pointer:fine)]:hover:not-active:bg-border"
      >
        <Xmark className="size-[1.3em]" />
        <span className="sr-only">Close editor and discard changes</span>
      </button>
    </div>
  );
}

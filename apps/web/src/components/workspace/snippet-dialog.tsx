import { useId, useState } from "react";
import { MAX_FILE_NAME_LENGTH } from "@ember/protocol";
import { FIELD_INPUT, Field } from "@/components/field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { savesEdit } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { DIALOG, DIALOG_BACKDROP, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

/** What a snippet's file is called, past its title: `.txt`, unless the title ends in an extension of its own. */
const TEXT_EXTENSION = ".txt";

/**
 * A snippet's file name: its title, or Untitled, as a text file unless the title ends in an extension of
 * its own, such as `deploy.sh`. Slashes would name folders, so they're dashes.
 */
export function snippetName(title: string): string {
  const name = title.trim().replace(/[/\\]/g, "-") || "Untitled";
  return /\.[a-z][a-z0-9]{0,7}$/i.test(name) ? name : `${name}${TEXT_EXTENSION}`;
}

interface Props {
  open: boolean;
  /** Adds the snippet, as a text file, to what goes with the next message. */
  onCreate: (file: File) => void;
  onOpenChange: (open: boolean) => void;
  /** Puts focus back in the composer's text once the dialog's gone. */
  onClosed: () => void;
}

/**
 * Slack's Text snippet: a title, which names the file, and the text, which Create snippet adds as a text
 * file to send with the next message, as a file picked is. Cmd or Ctrl+Enter creates it too.
 */
export function SnippetDialog({ open, onCreate, onOpenChange, onClosed }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
        className={cn(DIALOG, "w-[600px]")}
      >
        {/* Empty each time it opens. */}
        {open && (
          <SnippetForm
            onCreate={(file) => {
              onCreate(file);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SnippetForm({ onCreate, onCancel }: { onCreate: (file: File) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const id = useId();
  const blank = text.trim() === "";
  const create = () => {
    if (!blank) onCreate(new File([text], snippetName(title), { type: "text/plain" }));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <DialogTitle className={DIALOG_TITLE}>Create a text snippet</DialogTitle>
      <DialogDescription className="sr-only">A title, which names the snippet's file, and its text, which goes with your next message as a text file.</DialogDescription>
      <div className="mt-4 flex flex-col gap-4">
        <Field id={`${id}-title`} label="Title (optional)">
          <Input
            id={`${id}-title`}
            value={title}
            maxLength={MAX_FILE_NAME_LENGTH - TEXT_EXTENSION.length}
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
            className={FIELD_INPUT}
          />
        </Field>
        <Field id={`${id}-text`} label="Content">
          <Textarea
            id={`${id}-text`}
            value={text}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (!savesEdit(event.nativeEvent)) return;
              event.preventDefault();
              create();
            }}
            // As an agent's prompt is written (prompt-preview.tsx), in 16px type on touch screens, so phones don't zoom in.
            className={cn(FIELD_INPUT, "max-h-[50dvh] min-h-[220px] resize-y px-[1.5ch] py-3 font-mono text-[13px] leading-[1.5] md:text-[13px] touch:text-base")}
          />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
        <button type="button" onClick={onCancel} className={OTHER_ACTION}>
          Cancel
        </button>
        <button type="submit" disabled={blank} className={MAIN_ACTION}>
          Create snippet
        </button>
      </div>
    </form>
  );
}

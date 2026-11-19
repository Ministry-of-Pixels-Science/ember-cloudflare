import { useState, type FormEvent } from "react";
import { blockedWordsRefusal, blockedWordsTyped } from "@ember/protocol/blocked-words";
import { FIELD_INPUT, Field } from "@/components/field";
import { cn } from "@/lib/utils";

// The Blocked words card in Membership, for administrators, as Apple asks of every app where people
// post: the words and phrases nobody can use, in a message, a reaction, a file's or a room's name, or
// their own name, username or bio, typed one a line or apart by commas. The Worker checks against them,
// so no app can get round them, and only administrators see them. Laid out as Invite by email is.

/** The card's button, as the other cards' are. */
const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-[9px] border bg-background px-3.5 py-2.5 font-medium disabled:opacity-50";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** Whether `words` lists the same words and phrases as `kept`, in the same order. */
const sameWords = (words: readonly string[], kept: readonly string[]) => words.length === kept.length && words.every((word, index) => word === kept[index]);

interface Props {
  /** The words and phrases blocked, as kept. */
  words: string[];
  /** Saves `words` in place of those blocked, then calls `settled` with whether it did. */
  saveWords: (words: string[], settled: (saved: boolean) => void) => void;
}

/** Blocked words, for administrators: the list, one a line, to change and save, saying which word or phrase can't be blocked, if one can't. */
export function BlockedWordsSettings({ words, saveWords }: Props) {
  // What's typed, or null while it's the list as kept.
  const [typed, setTyped] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = typed ?? words.join("\n");
  const listed = blockedWordsTyped(text);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const refused = blockedWordsRefusal(listed);
    setRefusal(refused);
    if (refused !== null) return;
    setSaving(true);
    saveWords(listed, (saved) => {
      setSaving(false);
      // Shown as kept: one a line, each once.
      if (saved) setTyped(null);
    });
  };

  return (
    <section aria-labelledby="blocked-words-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <h2 id="blocked-words-heading" className="text-base font-semibold">
          Blocked words
        </h2>
        <p className={NOTE}>
          Nobody can use these in a message, a reaction, a file's or a room's name, or their own name, username or bio. They match whole words, ignoring case and
          accents, so a short word doesn't block longer ones. Only administrators see this list.
        </p>
      </div>
      <form onSubmit={save} className="flex flex-col items-start gap-3">
        <div className="w-full">
          <Field id="blocked_words" label="Words and phrases, one a line or apart by commas">
            <textarea
              id="blocked_words"
              rows={4}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={text}
              disabled={saving}
              aria-invalid={refusal !== null}
              aria-describedby={refusal === null ? undefined : "blocked-words-refusal"}
              onChange={(event) => {
                setTyped(event.target.value);
                setRefusal(null);
              }}
              className={cn("w-full border placeholder:text-muted-foreground", FIELD_INPUT, "resize-y")}
            />
          </Field>
        </div>
        {refusal !== null && (
          <p id="blocked-words-refusal" role="alert" className={cn(NOTE, "text-negative wrap-anywhere")}>
            {refusal}
          </p>
        )}
        {!sameWords(listed, words) && (
          <button type="submit" disabled={saving} className={BUTTON}>
            Save blocked words
          </button>
        )}
      </form>
    </section>
  );
}

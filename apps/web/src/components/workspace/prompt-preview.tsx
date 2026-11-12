import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { MAX_TEMPLATE_LENGTH, PLACEHOLDERS, placeholderOf, placesForInstructions, templateRefusal, type Placeholder, type Prompt } from "@ember/protocol/prompts";
import { FIELD_INPUT } from "@/components/field";
import { WarningTriangle } from "@/components/icons/iconoir";
import { cn } from "@/lib/utils";
import { BUTTON } from "./email-settings";

// What Ember adds around the instructions typed on an agent's page, or on @ember's: what its model reads
// before the conversation, as the Worker writes it (`promptAround`), the instructions in their place,
// for a question the administrator looking writes to it directly, as Try it asks one. Administrators may
// modify it, as the project's owner asked (2026-11-11), in a box that asks them to take care first, as
// Custom CSS does: Modify opens the template Ember fills in, with what each placeholder stands for, and
// Use Ember's own puts back Ember's, which then changes as Ember does.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** The template's box: monospaced, as the preview is, but in 16px for fingers, so phones don't zoom in. */
const TEMPLATE = cn("w-full resize-y border font-mono disabled:opacity-50", FIELD_INPUT, "px-[1.5ch] py-3 text-[13px] leading-[1.5] md:text-[13px] touch:text-base");

/** What the preview says of what it shows, for the agent called `name`. */
export const aroundExplained = (name: string) =>
  `Ember tells ${name} who it is, how the chat shows an answer and the cards it can show under one, and where it's asked, then gives it the conversation, each message after its writer's name. Your instructions go after who it is. For a question you write to it directly, it reads:`;

/** What the box asks care for, of the agent called `name`. */
export const cautionFor = (name: string) =>
  `Every answer ${name} gives starts from these words. A change here can leave it unsure who it is, where it's asked or what the chat can show, so change only what you need to.`;

/** What the box says Ember does with the placeholders, for the agent called `name`. */
export const placeholdersExplained = (name: string) => `Ember fills in each of these whenever ${name} is asked:`;

/** What each placeholder stands for, as the box lists them. */
export const PLACEHOLDER_MEANINGS: Record<Placeholder, string> = {
  name: "its name",
  community: "the community's name",
  where: "the room, thread or direct message it's asked in",
  asker: "the name of whoever asked",
  words: "about how many words it may answer in",
  cards: "how it can show cards under its answer, with what they can hold and how to write them",
  web: "what it may do on the web",
  today: "today's date, in UTC",
  instructions: "your instructions, which it needs once",
};

interface Props {
  /** What the page calls whoever answers: @ember, an agent by its name, or the agent, before it has one. */
  name: string;
  /** What it's told around its instructions, from `template`, for a question the administrator writes to it directly. */
  prompt: Prompt;
  /** What Ember adds around them as the page has it, saved or not, and Ember's own, for whoever answers. */
  template: string;
  ownTemplate: string;
  /** Why the page refused the template, which the box says until it's changed, opening to say it each time it's refused, or null. */
  refusal: { error: string } | null;
  disabled: boolean;
  onChange: (template: string) => void;
  /** The level of the box's heading, one under its section's. */
  heading: "h3" | "h4";
  /** What saves the template, on a page that saves it on its own, as @ember's does, beside Use Ember's own. */
  save?: ReactNode;
}

/**
 * What Ember adds around them, closed until it's opened, and opened when the page refused what it has:
 * `prompt`, with a mark where the instructions go, and the box that asks for care before the template is
 * modified, which shows the template once Modify is pressed, or while it isn't Ember's own, saying why
 * it can't be saved, if it can't, with what each placeholder stands for, and Use Ember's own.
 */
export function PromptPreview({ name, prompt, template, ownTemplate, refusal, disabled, onChange, heading: Heading, save }: Props) {
  // Whether Modify was pressed, after which the template stays, though it's Ember's own again.
  const [modifying, setModifying] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const modified = template.trim() !== ownTemplate;
  const said = refusal?.error ?? templateRefusal(template.trim());

  useEffect(() => {
    if (refusal !== null && details.current) details.current.open = true;
  }, [refusal]);

  /** Shows the template in place of Modify, which then has nowhere to keep the focus, so the template takes it. */
  const modify = () => {
    flushSync(() => setModifying(true));
    box.current?.focus();
  };

  return (
    <details ref={details} className="border-t pt-4">
      {/* 44px tall for fingers, its words where they were. */}
      <summary className="cursor-pointer text-sm font-semibold touch:-mt-3 touch:py-3">
        <span id={`${id}-title`}>What Ember adds around them</span>
        {modified && <span className="ms-[1ch] rounded-full border border-caution-border bg-caution-background px-2 py-px text-[0.8em] font-medium">Modified</span>}
      </summary>
      <p className={cn(NOTE, "mt-2 touch:mt-0")}>{aroundExplained(name)}</p>
      <div className="mt-3 rounded-[9px] border bg-background px-[1.5ch] py-3 font-mono text-[13px] leading-[1.5] whitespace-pre-wrap wrap-anywhere text-muted-foreground">
        {prompt.before}
        {placesForInstructions(template) > 0 && <span className="rounded-[4px] bg-foreground/8 px-1 text-foreground">Your instructions</span>}
        {prompt.after}
      </div>
      <section aria-labelledby={`${id}-caution`} className="mt-4 flex flex-col gap-3 rounded-[10px] border border-caution-border bg-caution-background px-[1.5ch] py-3 max-md:px-3">
        <div className="flex gap-x-[1ch]">
          <WarningTriangle className="mt-px size-[18px] flex-none text-caution" />
          <div className="min-w-0">
            <Heading id={`${id}-caution`} className="text-sm font-semibold">
              Modify with caution
            </Heading>
            <p id={`${id}-caution-note`} className={NOTE}>
              {cautionFor(name)}
            </p>
          </div>
        </div>
        {modifying || modified || refusal !== null ? (
          <>
            <div className="flex flex-col gap-1.5">
              <textarea
                ref={box}
                aria-labelledby={`${id}-title`}
                aria-describedby={`${id}-caution-note ${said === null ? `${id}-count` : `${id}-refusal`}`}
                aria-invalid={said !== null || undefined}
                rows={20}
                maxLength={MAX_TEMPLATE_LENGTH}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={disabled}
                value={template}
                onChange={(event) => onChange(event.target.value)}
                className={TEMPLATE}
              />
              {said === null ? (
                <p id={`${id}-count`} className={cn(NOTE, "text-end")}>
                  {template.length.toLocaleString("en-US")} of {MAX_TEMPLATE_LENGTH.toLocaleString("en-US")} characters
                </p>
              ) : (
                <p id={`${id}-refusal`} role="alert" className={cn(NOTE, "wrap-anywhere text-negative")}>
                  {said}
                </p>
              )}
            </div>
            <div>
              <p className={NOTE}>{placeholdersExplained(name)}</p>
              <dl className={cn(NOTE, "mt-1.5 grid grid-cols-[auto_1fr] gap-x-[1.5ch] gap-y-1")}>
                {PLACEHOLDERS.map((placeholder) => (
                  <Fragment key={placeholder}>
                    <dt>
                      <code className="rounded-[4px] bg-foreground/8 px-1 font-mono text-foreground">{placeholderOf(placeholder)}</code>
                    </dt>
                    <dd>{PLACEHOLDER_MEANINGS[placeholder]}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
            <div className="flex flex-wrap gap-[1ch]">
              <button
                type="button"
                disabled={disabled || !modified}
                onClick={() => {
                  setModifying(true);
                  onChange(ownTemplate);
                }}
                className={BUTTON}
              >
                Use Ember's own
              </button>
              {save}
            </div>
          </>
        ) : (
          <div>
            <button type="button" disabled={disabled} onClick={modify} aria-describedby={`${id}-caution-note`} className={BUTTON}>
              Modify
            </button>
          </div>
        )}
      </section>
    </details>
  );
}

import {
  ANSWER_LENGTHS,
  ANSWER_WORDS,
  LEVEL_NAMES,
  THINKING_LEVELS,
  THINKING_TOKENS,
  thinkingTaken,
  thinkingTokensAt,
  type AnswerLength,
  type AnswerLevelChanges,
  type AnswerLevels,
  type ThinkingLevel,
} from "@ember/protocol/assistant";

// The two dials of @ember's answers, each a row of radio buttons: how much it thinks before it answers,
// and how long its answers are. A choice applies at once. The AI assistant tab sets the most each goes to
// for anyone's questions, and each person's profile their own levels, up to that. Thinking offers only
// the levels the model that answers takes, as asking it at each found when an administrator picked it,
// but all of them for a model that takes none, as they still set how much it may think.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What each level of thinking does, which its dial says under it. */
const THINKING_NOTES: Record<ThinkingLevel, string> = {
  off: "Answers at once, without thinking first.",
  low: `Thinks a little first, up to about ${THINKING_TOKENS.low.toLocaleString("en-US")} tokens.`,
  medium: `Thinks more first, up to about ${THINKING_TOKENS.medium.toLocaleString("en-US")} tokens.`,
  high: `Thinks the most first, up to about ${THINKING_TOKENS.high.toLocaleString("en-US")} tokens, which takes longest.`,
};

/** Levels named as one of them, the last after "or". */
const eitherOf = new Intl.ListFormat("en-US", { type: "disjunction" });

/**
 * What the Thinking dial says under it at `level`, for `model`: what the level does, and which levels
 * the model can't be set to, or what it's asked for instead of `level`, or for a model that takes none,
 * that it decides, up to the most `level` allows.
 */
function thinkingNoteOf(level: ThinkingLevel, model: ThinkingModel | undefined): string {
  const takes = model?.thinkingLevels;
  if (!model || !takes || takes.length === THINKING_LEVELS.length) return THINKING_NOTES[level];
  if (takes.length === 0) return `${model.name} can't be told how much to think, so it decides for itself, up to about ${thinkingTokensAt(level).toLocaleString("en-US")} tokens.`;
  const asked = thinkingTaken(level, takes) ?? level;
  if (asked !== level) return `${model.name} can't be set to ${LEVEL_NAMES[level]}, so it thinks at ${LEVEL_NAMES[asked]} instead.`;
  const refused = THINKING_LEVELS.filter((other) => !takes.includes(other)).map((other) => LEVEL_NAMES[other]);
  return `${THINKING_NOTES[level]} ${model.name} can't be set to ${eitherOf.format(refused)}.`;
}

/** How long each length's answers are, which its dial says under it. */
const LENGTH_NOTES: Record<AnswerLength, string> = {
  short: `About ${ANSWER_WORDS.short} words.`,
  medium: `About ${ANSWER_WORDS.medium} words.`,
  long: `About ${ANSWER_WORDS.long.toLocaleString("en-US")} words, nearly all one message holds.`,
};

/**
 * The model that answers at the dials' levels, by name, with the levels of thinking it takes, as asking
 * it at each found when an administrator picked it, or none for one Ember hasn't asked at each.
 */
export interface ThinkingModel {
  name: string;
  thinkingLevels?: ThinkingLevel[] | null;
}

interface Props {
  /** What the dials' radio buttons are named after, unique on the page. */
  name: string;
  levels: AnswerLevels;
  /** The most each dial may go to, above which its levels can't be chosen, or none to allow every level. */
  most?: AnswerLevels;
  /** The model that answers at these levels, the Thinking dial offering only the levels it takes, or none to offer each. */
  model?: ThinkingModel;
  disabled?: boolean;
  onChange: (changes: AnswerLevelChanges) => void;
}

/** The Thinking and Answer length dials, set at `levels`. */
export function LevelDials({ name, levels, most, model, disabled = false, onChange }: Props) {
  const takes = model?.thinkingLevels;
  return (
    <div className="flex flex-col gap-4">
      <Dial
        name={`${name}-thinking`}
        legend="Thinking"
        order={THINKING_LEVELS}
        chosen={levels.thinking}
        highest={most?.thinking}
        taken={takes && takes.length > 0 ? takes : undefined}
        note={thinkingNoteOf(levels.thinking, model)}
        disabled={disabled}
        onChoose={(thinking) => onChange({ thinking })}
      />
      <Dial
        name={`${name}-length`}
        legend="Answer length"
        order={ANSWER_LENGTHS}
        chosen={levels.length}
        highest={most?.length}
        note={LENGTH_NOTES[levels.length]}
        disabled={disabled}
        onChoose={(length) => onChange({ length })}
      />
    </div>
  );
}

interface DialProps<T extends ThinkingLevel | AnswerLength> {
  name: string;
  legend: string;
  order: readonly T[];
  chosen: T;
  highest: T | undefined;
  /** The only levels that can be chosen, besides those above `highest`, or none to allow each. */
  taken?: readonly T[];
  note: string;
  disabled: boolean;
  onChoose: (level: T) => void;
}

/** One dial: its levels in `order`, `chosen` checked, those above `highest` or not `taken` disabled, and what the chosen one does under them. */
function Dial<T extends ThinkingLevel | AnswerLength>({ name, legend, order, chosen, highest, taken, note, disabled, onChoose }: DialProps<T>) {
  const top = highest === undefined ? order.length - 1 : order.indexOf(highest);
  return (
    <fieldset aria-describedby={`${name}-note`} className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-semibold">{legend}</legend>
      <div className="flex w-fit max-w-full flex-wrap rounded-[8px] border bg-background p-0.5">
        {order.map((level, index) => (
          <label
            key={level}
            className="relative cursor-pointer rounded-[6px] px-3 py-1 text-sm hover:bg-hover has-checked:bg-hover has-checked:font-semibold has-disabled:cursor-default has-disabled:opacity-50 has-disabled:hover:bg-transparent has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-foreground touch:min-h-11 touch:py-2.5"
          >
            <input
              type="radio"
              name={name}
              value={level}
              checked={chosen === level}
              disabled={disabled || index > top || (taken !== undefined && !taken.includes(level))}
              onChange={() => onChoose(level)}
              className="absolute size-px opacity-0 [clip-path:inset(50%)]"
            />
            {LEVEL_NAMES[level]}
          </label>
        ))}
      </div>
      <p id={`${name}-note`} className={NOTE}>
        {note}
      </p>
    </fieldset>
  );
}

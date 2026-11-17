import type { UserId } from "@ember/protocol";

// The reactions that show in a huddle, as Slack's do: each rises from the base of the people in it,
// over its sender's name, from when the room tells of it, for `REACTION_SHOWS_MS`. While an emoji
// rises it has a pill, which says who sent the first of them and how many have come since, and sends
// it again.

/** How long a reaction shows, which is as long as it takes to rise and fade (index.css's `reaction`). */
export const REACTION_SHOWS_MS = 4_000;
/** The most reactions that rise at once: with more, the oldest go early. */
export const MOST_RISING = 24;
/** The most emoji that have a pill at once, which are the latest to start. */
export const MOST_PILLS = 3;

/** A reaction that rises: which of the huddle's reactions it is, counted from 1, by which the same emoji sent again is another, and whose it is. */
export interface RisingReaction {
  nth: number;
  userId: UserId;
  emoji: string;
}

/** An emoji that rises, as its pill tells of it: who sent the first of them, and how many have come since, from anyone. */
export interface ReactionRun {
  emoji: string;
  first: UserId;
  more: number;
}

/** The reactions a huddle shows: those that rise, the oldest first, and the emoji that have a pill, in the order they started. */
export interface ShownReactions {
  rising: readonly RisingReaction[];
  runs: readonly ReactionRun[];
}

export const NO_REACTIONS: ShownReactions = { rising: [], runs: [] };

/** What shows a huddle's reactions. */
export interface HuddleReactions {
  /** Shows `whose` reaction from now. */
  show(whose: UserId, emoji: string): void;
  /** Shows nothing more of `whose`, who has left: an emoji they were first to send is the next sender's from then. */
  forget(whose: UserId): void;
  /** Shows none of them, for good. */
  stop(): void;
}

/** Has `changed` hear the reactions that show whenever one comes or goes. */
export function reactionsShown(changed: (shown: ShownReactions) => void): HuddleReactions {
  let rising: RisingReaction[] = [];
  let runs: ReactionRun[] = [];
  const going = new Map<number, ReturnType<typeof setTimeout>>();
  let count = 0;
  const tell = () => changed({ rising, runs: runs.slice(-MOST_PILLS) });

  /** Leaves `gone` out of those that rise, and ends the run of an emoji none of which rises any more. */
  const drop = (gone: readonly RisingReaction[]) => {
    for (const { nth } of gone) {
      clearTimeout(going.get(nth));
      going.delete(nth);
    }
    rising = rising.filter((reaction) => !gone.includes(reaction));
    runs = runs.filter(({ emoji }) => rising.some((reaction) => reaction.emoji === emoji));
  };

  return {
    show(whose, emoji) {
      const reaction: RisingReaction = { nth: ++count, userId: whose, emoji };
      rising = [...rising, reaction];
      const gone = () => {
        drop([reaction]);
        tell();
      };
      going.set(reaction.nth, setTimeout(gone, REACTION_SHOWS_MS));
      const run = runs.find((each) => each.emoji === emoji);
      runs = run ? runs.map((each) => (each === run ? { ...run, more: run.more + 1 } : each)) : [...runs, { emoji, first: whose, more: 0 }];
      if (rising.length > MOST_RISING) drop(rising.slice(0, rising.length - MOST_RISING));
      tell();
    },
    forget(whose) {
      const theirs = rising.filter(({ userId }) => userId === whose);
      if (theirs.length === 0 && !runs.some(({ first }) => first === whose)) return;
      drop(theirs);
      // Whatever still rises of an emoji they were first to send is someone else's.
      runs = runs.map((run) => (run.first === whose ? { ...run, first: rising.find(({ emoji }) => emoji === run.emoji)!.userId } : run));
      tell();
    },
    stop() {
      if (rising.length === 0) return;
      drop(rising);
      tell();
    },
  };
}

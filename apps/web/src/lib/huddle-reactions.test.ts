import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOST_PILLS, MOST_RISING, REACTION_SHOWS_MS, reactionsShown, type ShownReactions } from "./huddle-reactions";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** What shows reactions, with what it last told of. */
function showing() {
  const changed = vi.fn<(shown: ShownReactions) => void>();
  const reactions = reactionsShown(changed);
  return { changed, reactions, shown: () => changed.mock.lastCall![0] };
}

describe("The reactions that show in a huddle", () => {
  it("shows each from when it comes, counted from the first, for as long as it takes to rise, the oldest first", () => {
    const { changed, reactions, shown } = showing();
    reactions.show("ada", "🎉");
    expect(shown()).toEqual({ rising: [{ nth: 1, userId: "ada", emoji: "🎉" }], runs: [{ emoji: "🎉", first: "ada", more: 0 }] });
    vi.advanceTimersByTime(1_000);
    reactions.show("sam", "👍");
    expect(shown()).toEqual({
      rising: [
        { nth: 1, userId: "ada", emoji: "🎉" },
        { nth: 2, userId: "sam", emoji: "👍" },
      ],
      runs: [
        { emoji: "🎉", first: "ada", more: 0 },
        { emoji: "👍", first: "sam", more: 0 },
      ],
    });

    vi.advanceTimersByTime(REACTION_SHOWS_MS - 1_001);
    expect(changed).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual({ rising: [{ nth: 2, userId: "sam", emoji: "👍" }], runs: [{ emoji: "👍", first: "sam", more: 0 }] });
    vi.advanceTimersByTime(1_000);
    expect(shown()).toEqual({ rising: [], runs: [] });
    expect(changed).toHaveBeenCalledTimes(4);
    // What it told of before is as it was then.
    expect(changed.mock.calls.map(([{ rising, runs }]) => [rising.length, runs.length])).toEqual([
      [1, 1],
      [2, 2],
      [1, 1],
      [0, 0],
    ]);
  });

  it("shows someone's next beside their last, and the same emoji again as another", () => {
    const { changed, reactions, shown } = showing();
    reactions.show("ada", "🎉");
    vi.advanceTimersByTime(REACTION_SHOWS_MS - 1);
    reactions.show("ada", "🎉");
    expect(shown().rising.map(({ nth, userId, emoji }) => [nth, userId, emoji])).toEqual([
      [1, "ada", "🎉"],
      [2, "ada", "🎉"],
    ]);

    // The first one's time is up, which the second's isn't.
    vi.advanceTimersByTime(1);
    expect(shown().rising.map(({ nth }) => nth)).toEqual([2]);
    vi.advanceTimersByTime(REACTION_SHOWS_MS - 2);
    expect(changed).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual({ rising: [], runs: [] });
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("counts an emoji sent again while it rises, after whoever sent the first, until the last of them has gone", () => {
    const { reactions, shown } = showing();
    reactions.show("ada", "🎉");
    vi.advanceTimersByTime(1_000);
    reactions.show("sam", "🎉");
    expect(shown().runs).toEqual([{ emoji: "🎉", first: "ada", more: 1 }]);
    vi.advanceTimersByTime(1_000);
    reactions.show("ada", "🎉");
    reactions.show("sam", "👍");
    expect(shown().runs).toEqual([
      { emoji: "🎉", first: "ada", more: 2 },
      { emoji: "👍", first: "sam", more: 0 },
    ]);

    // Ada's first has gone, and the count is of all there were since.
    vi.advanceTimersByTime(REACTION_SHOWS_MS - 2_000);
    expect(shown().rising.map(({ nth }) => nth)).toEqual([2, 3, 4]);
    expect(shown().runs[0]).toEqual({ emoji: "🎉", first: "ada", more: 2 });
    // And with the last of them, the count.
    vi.advanceTimersByTime(2_000);
    expect(shown()).toEqual({ rising: [], runs: [] });
    reactions.show("sam", "🎉");
    expect(shown().runs).toEqual([{ emoji: "🎉", first: "sam", more: 0 }]);
  });

  it("has the latest emoji to start for its pills, and no more of them than there's room for", () => {
    const { reactions, shown } = showing();
    const emoji = ["🎉", "👍", "👀", "🙌", "✅"];
    expect(emoji.length).toBe(MOST_PILLS + 2);
    for (const each of emoji) {
      reactions.show("ada", each);
      vi.advanceTimersByTime(500);
    }
    expect(shown().rising).toHaveLength(emoji.length);
    expect(shown().runs.map((run) => run.emoji)).toEqual(["👀", "🙌", "✅"]);
    // One sent again is where it was among them.
    reactions.show("sam", "👍");
    expect(shown().runs.map((run) => run.emoji)).toEqual(["👀", "🙌", "✅"]);
    reactions.show("sam", "👀");
    expect(shown().runs).toEqual([
      { emoji: "👀", first: "ada", more: 1 },
      { emoji: "🙌", first: "ada", more: 0 },
      { emoji: "✅", first: "ada", more: 0 },
    ]);
  });

  it("lets the oldest go early once more rise than it shows at once", () => {
    const { reactions, shown } = showing();
    reactions.show("sam", "👍");
    for (let sent = 0; sent < MOST_RISING; sent++) reactions.show("ada", "🎉");
    expect(shown().rising).toHaveLength(MOST_RISING);
    expect(shown().rising.map(({ nth }) => nth)).toEqual(Array.from({ length: MOST_RISING }, (_, index) => index + 2));
    // Sam's was the only one of its emoji.
    expect(shown().runs).toEqual([{ emoji: "🎉", first: "ada", more: MOST_RISING - 1 }]);
    expect(vi.getTimerCount()).toBe(MOST_RISING);

    reactions.show("ada", "🎉");
    expect(shown().rising.map(({ nth }) => nth)).toEqual(Array.from({ length: MOST_RISING }, (_, index) => index + 3));
    expect(shown().runs).toEqual([{ emoji: "🎉", first: "ada", more: MOST_RISING }]);
    vi.advanceTimersByTime(REACTION_SHOWS_MS);
    expect(shown()).toEqual({ rising: [], runs: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows nothing more of someone it's told to forget, whose emoji is whoever sent it next's, and says nothing of forgetting whoever shows none", () => {
    const { changed, reactions, shown } = showing();
    reactions.show("ada", "🎉");
    reactions.show("sam", "🎉");
    reactions.show("ada", "👍");
    reactions.show("priya", "🎉");
    reactions.forget("ada");
    expect(shown().rising.map(({ nth, userId }) => [nth, userId])).toEqual([
      [2, "sam"],
      [4, "priya"],
    ]);
    // Her thumbs up was the only one, and the count of the other is of all there were.
    expect(shown().runs).toEqual([{ emoji: "🎉", first: "sam", more: 2 }]);
    reactions.forget("ada");
    reactions.forget("linus");
    expect(changed).toHaveBeenCalledTimes(5);

    // And it's the others' alone that go when their time is up.
    vi.advanceTimersByTime(REACTION_SHOWS_MS);
    expect(shown()).toEqual({ rising: [], runs: [] });
    expect(changed).toHaveBeenCalledTimes(7);
  });

  it("gives an emoji to whoever sent the next once whoever sent the first is forgotten, though theirs has gone by then", () => {
    const { changed, reactions, shown } = showing();
    reactions.show("ada", "🎉");
    vi.advanceTimersByTime(1_000);
    reactions.show("sam", "🎉");
    vi.advanceTimersByTime(REACTION_SHOWS_MS - 1_000);
    expect(shown()).toEqual({ rising: [{ nth: 2, userId: "sam", emoji: "🎉" }], runs: [{ emoji: "🎉", first: "ada", more: 1 }] });
    reactions.forget("ada");
    expect(shown()).toEqual({ rising: [{ nth: 2, userId: "sam", emoji: "🎉" }], runs: [{ emoji: "🎉", first: "sam", more: 1 }] });
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("shows none once it's stopped, and has nothing left to go", () => {
    const { changed, reactions, shown } = showing();
    reactions.show("ada", "🎉");
    reactions.show("sam", "👍");
    reactions.stop();
    expect(shown()).toEqual({ rising: [], runs: [] });
    const told = changed.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(REACTION_SHOWS_MS);
    reactions.stop();
    expect(changed).toHaveBeenCalledTimes(told);
  });
});

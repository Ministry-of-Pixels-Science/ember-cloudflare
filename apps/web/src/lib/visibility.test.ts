import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settledVisibility, VISIBILITY_CHANGE_DELAY_MS, whenShownAgain, type SettledVisibility } from "./visibility";

const wait = (ms: number) => vi.advanceTimersByTime(ms);
const visibility = (state: DocumentVisibilityState) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

// Each test's follower, stopped after it so it stops listening to the tab.
let followed: SettledVisibility | undefined;
const follow = (onChange: (visible: boolean) => void = () => {}) => (followed = settledVisibility(onChange));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  followed?.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Presence", () => {
  it("starts out as the tab is", () => {
    expect(follow().visible).toBe(true);
    followed!.stop();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(follow().visible).toBe(false);
  });

  it("counts the tab as hidden, and shown again, once it has stayed so for 5 seconds", () => {
    const onChange = vi.fn();
    const tab = follow(onChange);
    visibility("hidden");
    wait(VISIBILITY_CHANGE_DELAY_MS - 1);
    expect([tab.visible, onChange.mock.calls]).toEqual([true, []]);
    wait(1);
    expect([tab.visible, onChange.mock.calls]).toEqual([false, [[false]]]);

    visibility("visible");
    wait(VISIBILITY_CHANGE_DELAY_MS);
    expect([tab.visible, onChange.mock.calls]).toEqual([true, [[false], [true]]]);
  });

  it("ignores a glance at another tab, and waits for the tab to settle", () => {
    const onChange = vi.fn();
    const tab = follow(onChange);
    visibility("hidden");
    wait(3_000);
    visibility("visible");
    wait(VISIBILITY_CHANGE_DELAY_MS);
    expect(onChange).not.toHaveBeenCalled();

    // Hidden, shown and hidden again: 5 seconds from the last change.
    visibility("hidden");
    wait(3_000);
    visibility("visible");
    wait(1_000);
    visibility("hidden");
    wait(VISIBILITY_CHANGE_DELAY_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    wait(1);
    expect([tab.visible, onChange.mock.calls]).toEqual([false, [[false]]]);
  });

  it("stops following the tab once stopped", () => {
    const onChange = vi.fn();
    const tab = follow(onChange);
    visibility("hidden");
    tab.stop();
    wait(VISIBILITY_CHANGE_DELAY_MS);
    visibility("visible");
    visibility("hidden");
    wait(VISIBILITY_CHANGE_DELAY_MS);
    expect([tab.visible, onChange.mock.calls]).toEqual([true, []]);
  });
});

describe("A tab that shows again", () => {
  it("is heard of each time it shows, at once, and not as it's hidden, until it's told to stop", () => {
    const shown = vi.fn();
    const stop = whenShownAgain(shown);
    expect(shown).not.toHaveBeenCalled();
    visibility("hidden");
    expect(shown).not.toHaveBeenCalled();
    visibility("visible");
    expect(shown).toHaveBeenCalledTimes(1);
    visibility("hidden");
    visibility("visible");
    expect(shown).toHaveBeenCalledTimes(2);

    stop();
    visibility("hidden");
    visibility("visible");
    expect(shown).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeAfter, AWAY_AFTER_MS, watchUse } from "./presence";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const showTab = (state: DocumentVisibilityState) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("Who's active", () => {
  it("counts the tab in use as it starts, until it goes ten minutes unused, and again as soon as it's used", () => {
    const onChange = vi.fn();
    const use = watchUse(onChange);
    expect(use.inUse()).toBe(true);
    vi.advanceTimersByTime(AWAY_AFTER_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange.mock.calls).toEqual([[false]]);
    expect(use.inUse()).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(onChange.mock.calls).toEqual([[false], [true]]);
    expect(use.inUse()).toBe(true);
    use.stop();
  });

  it("counts the ten minutes from the last use, saying nothing of the uses while it's in use", () => {
    const onChange = vi.fn();
    const use = watchUse(onChange);
    vi.advanceTimersByTime(AWAY_AFTER_MS / 2);
    for (const type of ["pointermove", "pointerdown", "wheel", "touchstart"]) window.dispatchEvent(new Event(type));
    vi.advanceTimersByTime(AWAY_AFTER_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange.mock.calls).toEqual([[false]]);
    use.stop();
  });

  it("counts the tab in use again once it's shown or focused, but not as it's hidden", () => {
    const onChange = vi.fn();
    const use = watchUse(onChange);
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    showTab("hidden");
    expect(use.inUse()).toBe(false);
    showTab("visible");
    expect(use.inUse()).toBe(true);
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    window.dispatchEvent(new FocusEvent("focus"));
    expect(onChange.mock.calls).toEqual([[false], [true], [false], [true]]);
    use.stop();
  });

  it("stops watching once it's stopped", () => {
    const onChange = vi.fn();
    watchUse(onChange).stop();
    vi.advanceTimersByTime(AWAY_AFTER_MS);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes who's active from the first frame alone, then from the changes each frame after it tells of", () => {
    const first = activeAfter(new Set(["u1", "u2"]), { type: "presence", active: ["u3"], away: [] }, true);
    expect(first).toEqual(new Set(["u3"]));
    expect(activeAfter(first, { type: "presence", active: ["u1"], away: ["u3"] }, false)).toEqual(new Set(["u1"]));
    expect(first).toEqual(new Set(["u3"]));
    expect(activeAfter(null, { type: "presence", active: ["u1"], away: ["u2"] }, false)).toEqual(new Set(["u1"]));
  });
});

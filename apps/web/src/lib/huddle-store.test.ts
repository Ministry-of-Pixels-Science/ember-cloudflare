import { ALL_HUDDLE_SOUNDS, type HuddleSounds } from "@ember/protocol/huddles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heardSounds, hearSounds, watchHeardSounds } from "./huddle-store";

const NO_MUSIC: HuddleSounds = { ...ALL_HUDDLE_SOUNDS, music: false };

afterEach(() => hearSounds(ALL_HUDDLE_SOUNDS));

describe("Which of a huddle's sounds the tab's person hears", () => {
  it("is all of them until the page says which, and whoever watches hears of each change until they stop watching", () => {
    expect(heardSounds()).toEqual(ALL_HUDDLE_SOUNDS);
    const [first, second] = [vi.fn(), vi.fn()];
    const told = () => [first, second].map((listener) => listener.mock.calls.length);
    const [unwatchFirst, unwatchSecond] = [watchHeardSounds(first), watchHeardSounds(second)];
    expect(told()).toEqual([0, 0]);
    hearSounds(NO_MUSIC);
    expect(heardSounds()).toEqual(NO_MUSIC);
    expect(told()).toEqual([1, 1]);

    // A huddle that's over watches no longer, and the next goes on hearing.
    unwatchFirst();
    hearSounds(ALL_HUDDLE_SOUNDS);
    expect(heardSounds()).toEqual(ALL_HUDDLE_SOUNDS);
    expect(told()).toEqual([1, 2]);
    unwatchSecond();
    hearSounds(NO_MUSIC);
    expect(told()).toEqual([1, 2]);
  });
});

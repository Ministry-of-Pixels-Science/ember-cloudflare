import { ALL_HUDDLE_SOUNDS, HUDDLE_SOUNDS, type HuddleSound, type HuddleSounds, type HuddleSoundsChanged } from "@ember/protocol/huddles";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { HUDDLE_SOUND_LABELS, HuddleSoundSwitches } from "./huddle-sound-switches";

const NO_MUSIC: HuddleSounds = { ...ALL_HUDDLE_SOUNDS, music: false };

/** Huddle sounds for someone who hears `sounds`, with what keeps the sounds a save is answered with, and what says why one failed. */
function showSwitches(sounds = ALL_HUDDLE_SOUNDS) {
  const [answered, onFailed] = [vi.fn(), vi.fn()];
  const askForSounds = vi.fn(() => answered);
  const section = (heard: HuddleSounds) => <HuddleSoundSwitches sounds={heard} askForSounds={askForSounds} onFailed={onFailed} />;
  const { rerender, unmount } = render(section(sounds));
  return { askForSounds, answered, onFailed, unmount, user: userEvent.setup(), show: (heard: HuddleSounds) => rerender(section(heard)) };
}

const section = () => screen.getByRole("region", { name: "Huddle sounds" });
const switchOf = (sound: HuddleSound) => within(section()).getByRole("switch", { name: HUDDLE_SOUND_LABELS[sound] });
/** Whether each of the three switches is on, in the order they're listed. */
const switched = () => within(section()).getAllByRole("switch").map((each) => each.getAttribute("aria-checked") === "true");
/** What the switches have sent, in order. */
const sent = () => vi.mocked(fetch).mock.calls.map(([input, init]) => [String(input), init?.method, JSON.parse(String(init?.body))]);

/** Holds each save's answer until a test gives it, in the order the saves were sent. */
function holdAnswers() {
  const answers: Array<(response: Response) => void> = [];
  vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
  return (index: number, response: Response) => act(async () => answers[index]!(response));
}

const heard = (sounds: HuddleSounds) => Response.json({ sounds } satisfies HuddleSoundsChanged);

beforeEach(() => {
  vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("Huddle sounds on your profile", () => {
  it("has a switch for each of a huddle's sounds, under what they're for, each as your list has it, in any of your tabs", () => {
    const { show } = showSwitches({ music: false, chimes: true, ring: false });
    expect(within(section()).getByRole("heading", { level: 2, name: "Huddle sounds" })).toBeVisible();
    expect(section()).toHaveTextContent("Choose which huddle sounds you hear. Your choices apply everywhere you're signed in.");
    const switches = within(section()).getAllByRole("switch");
    expect(HUDDLE_SOUNDS).toEqual(["music", "chimes", "ring"]);
    expect(switches[0]).toHaveAccessibleName("Play music when you're the only one in a huddle");
    expect(switches[1]).toHaveAccessibleName("Play a sound when someone joins or leaves");
    expect(switches[2]).toHaveAccessibleName("Ring when someone invites you to a huddle");
    expect(switches).toHaveLength(3);
    expect(switched()).toEqual([false, true, false]);

    // Another tab turns the music back on, and the sounds of joining and leaving off.
    show({ music: true, chimes: false, ring: false });
    expect(switched()).toEqual([true, false, false]);
  });

  it("saves a switch at once, sending its sound alone, and stays where it was moved to until that's saved, moved no further meanwhile", async () => {
    const answer = holdAnswers();
    const { askForSounds, answered, user, show } = showSwitches();
    await user.click(switchOf("music"));
    expect(sent()).toEqual([["/api/users/me/huddle-sounds", "PATCH", { music: false }]]);
    expect(askForSounds).toHaveBeenCalledOnce();
    expect(switched()).toEqual([false, true, true]);
    await user.click(switchOf("music"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(switched()).toEqual([false, true, true]);
    expect(answered).not.toHaveBeenCalled();

    // Saved, it's as the list has it, which keeps the sounds the server answers.
    show(NO_MUSIC);
    await answer(0, heard(NO_MUSIC));
    expect(answered).toHaveBeenCalledExactlyOnceWith(NO_MUSIC);
    expect(switched()).toEqual([false, true, true]);
    await user.click(switchOf("music"));
    expect(sent().at(-1)).toEqual(["/api/users/me/huddle-sounds", "PATCH", { music: true }]);
    expect(switched()).toEqual([true, true, true]);
  });

  it("saves another switch while one is saved, each with its own sound", async () => {
    const answer = holdAnswers();
    const { askForSounds, answered, user, show } = showSwitches();
    await user.click(switchOf("chimes"));
    await user.click(switchOf("ring"));
    expect(sent().map(([, , changes]) => changes)).toEqual([{ chimes: false }, { ring: false }]);
    expect(askForSounds).toHaveBeenCalledTimes(2);
    expect(switched()).toEqual([true, false, false]);

    // The first is answered while the second is on its way, which stays where it was moved to.
    show({ music: true, chimes: false, ring: true });
    await answer(0, heard({ music: true, chimes: false, ring: true }));
    expect(switched()).toEqual([true, false, false]);
    show({ music: true, chimes: false, ring: false });
    await answer(1, heard({ music: true, chimes: false, ring: false }));
    expect(answered.mock.calls).toEqual([[{ music: true, chimes: false, ring: true }], [{ music: true, chimes: false, ring: false }]]);
    expect(switched()).toEqual([true, false, false]);
  });

  it("goes back to where it was, saying why, when saving it fails", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Something went wrong" }, { status: 500 }));
    const { answered, onFailed, user } = showSwitches();
    await user.click(switchOf("ring"));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(new ApiError(500, "Something went wrong"));
    expect(answered).not.toHaveBeenCalled();
    expect(switched()).toEqual([true, true, true]);

    // It can be moved again.
    await user.click(switchOf("ring"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("hands on the sounds a save is answered with once the page is gone, for the list to keep, and says only that the session has ended", async () => {
    const answer = holdAnswers();
    const left = showSwitches();
    await left.user.click(switchOf("music"));
    left.unmount();
    await answer(0, heard(NO_MUSIC));
    expect(left.answered).toHaveBeenCalledExactlyOnceWith(NO_MUSIC);

    for (const [index, status, told] of [
      [1, 500, false],
      [2, 401, true],
    ] as const) {
      const { answered, onFailed, user, unmount } = showSwitches();
      await user.click(switchOf("music"));
      unmount();
      await answer(index, Response.json({ error: "No" }, { status }));
      expect(onFailed).toHaveBeenCalledTimes(told ? 1 : 0);
      expect(answered).not.toHaveBeenCalled();
    }
  });
});

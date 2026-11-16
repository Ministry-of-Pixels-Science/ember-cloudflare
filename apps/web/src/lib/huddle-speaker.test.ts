import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { huddleSpeaker } from "./huddle-speaker";

/** Once what the speaker started has run as far as it goes without the browser. */
const settled = () => new Promise((resolve) => setTimeout(resolve));
const audio = () => document.createElement("audio");
const box = () => document.querySelector<HTMLElement>("[data-huddle-voices]");

/**
 * A browser that can choose a speaker, as Safari can't: each `<audio>` says the one it was last told to
 * play through, which is never one of those `refused`. It takes its time over `slow`: until `take` is called.
 */
function choosesSpeakers({ refused = [], slow }: { refused?: string[]; slow?: string } = {}) {
  let take = () => {};
  const taken = new Promise<void>((resolve) => (take = resolve));
  const setSinkId = vi.fn(async function (this: HTMLMediaElement, deviceId: string) {
    if (deviceId === slow) await taken;
    if (refused.includes(deviceId)) throw new DOMException("Refused", "NotAllowedError");
    Object.defineProperty(this, "sinkId", { configurable: true, value: deviceId });
  });
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
  return Object.assign(setSinkId, { take });
}

/** The speakers the browser lists, which the function returned changes as plugging one in or unplugging it does. */
function lists(...ids: string[]) {
  const speakers = (of: string[]) => of.map((deviceId) => ({ kind: "audiooutput", deviceId }));
  const enumerateDevices = vi.fn(async () => speakers(ids));
  const media = Object.assign(new EventTarget(), { enumerateDevices });
  vi.stubGlobal("navigator", { mediaDevices: media });
  return async (...now: string[]) => {
    enumerateDevices.mockResolvedValue(speakers(now));
    media.dispatchEvent(new Event("devicechange"));
    await settled();
  };
}

let play: MockInstance<HTMLMediaElement["play"]>;
let pause: MockInstance<HTMLMediaElement["pause"]>;

beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  box()?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("What a huddle's speaker plays until it's stopped", () => {
  it("plays in the page, hidden, and goes on from where it stopped when it's played again", () => {
    const speaker = huddleSpeaker("");
    const music = audio();
    speaker.play(music);
    expect(music.parentElement).toBe(box());
    expect(box()!.hidden).toBe(true);
    expect(play.mock.contexts).toEqual([music]);

    music.currentTime = 12;
    speaker.stop(music);
    expect(pause.mock.contexts).toEqual([music]);
    expect(music.isConnected).toBe(false);

    speaker.play(music);
    expect(music.parentElement).toBe(box());
    expect(music.currentTime).toBe(12);
    expect(play.mock.contexts).toEqual([music, music]);
  });

  it("plays again through the system's speaker what it had stopped when the chosen one was unplugged, and through the chosen one once that's back", async () => {
    const setSinkId = choosesSpeakers();
    const changeTo = lists("default", "headphones");
    const speaker = huddleSpeaker("headphones");
    const music = audio();
    speaker.play(music);
    speaker.stop(music);
    expect(setSinkId.mock.calls).toEqual([["headphones"]]);

    // Stopped, it isn't told as the speaker is unplugged, and would play nothing through it.
    await changeTo("default");
    expect(setSinkId).toHaveBeenCalledTimes(1);
    speaker.play(music);
    expect(setSinkId.mock.calls).toEqual([["headphones"], [""]]);

    speaker.stop(music);
    await changeTo("default", "headphones");
    speaker.play(music);
    expect(setSinkId.mock.calls).toEqual([["headphones"], [""], ["headphones"]]);
    expect(setSinkId.mock.contexts).toEqual([music, music, music]);
    speaker.stopAll();
  });

  it("leaves what it plays to the system's speaker when none was chosen", () => {
    const setSinkId = choosesSpeakers();
    const speaker = huddleSpeaker("");
    const voice = audio();
    speaker.play(voice);
    speaker.playOnce(audio());
    expect(setSinkId).not.toHaveBeenCalled();
    speaker.stopAll();
  });

  it("stops for good with the huddle, which takes its box out of the page", () => {
    const speaker = huddleSpeaker("");
    const [voice, music] = [audio(), audio()];
    speaker.play(voice);
    speaker.play(music);
    speaker.stopAll();
    expect(pause.mock.contexts).toEqual([voice, music]);
    expect(box()).toBeNull();
  });
});

describe("What a huddle's speaker plays once", () => {
  it("plays from its start, outside the page", () => {
    const speaker = huddleSpeaker("");
    const sound = audio();
    sound.currentTime = 0.4;
    speaker.playOnce(sound);
    expect(sound.currentTime).toBe(0);
    expect(play.mock.contexts).toEqual([sound]);
    expect(sound.isConnected).toBe(false);
    expect(box()).toBeNull();
  });

  it("plays through the speaker chosen, and through the system's for as long as that one is unplugged", async () => {
    const setSinkId = choosesSpeakers();
    const changeTo = lists("default", "headphones");
    const speaker = huddleSpeaker("headphones");
    const sound = audio();
    speaker.playOnce(sound);
    // Told once where to play, it plays there until that changes.
    speaker.playOnce(sound);
    expect(setSinkId.mock.calls).toEqual([["headphones"]]);
    expect(setSinkId.mock.contexts).toEqual([sound]);

    // Unplugged between two sounds, the speaker would play nothing of the second.
    await changeTo("default");
    expect(setSinkId).toHaveBeenCalledTimes(1);
    speaker.playOnce(sound);
    expect(setSinkId.mock.calls).toEqual([["headphones"], [""]]);

    await changeTo("default", "headphones");
    speaker.playOnce(sound);
    expect(setSinkId.mock.calls).toEqual([["headphones"], [""], ["headphones"]]);
    expect(play).toHaveBeenCalledTimes(4);
  });

  it("asks nothing of a browser that can't choose a speaker", () => {
    const speaker = huddleSpeaker("headphones");
    const sound = audio();
    expect(() => speaker.playOnce(sound)).not.toThrow();
    expect(play.mock.contexts).toEqual([sound]);
  });

  it("isn't kept for the person's next touch when the browser refuses it, as what plays until it's stopped is", async () => {
    play.mockRejectedValue(new DOMException("play() failed", "NotAllowedError"));
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockReturnValue(true);
    const speaker = huddleSpeaker("");
    const [sound, voice] = [audio(), audio()];
    speaker.playOnce(sound);
    speaker.play(voice);
    await settled();

    document.body.click();
    expect(play.mock.contexts).toEqual([sound, voice, voice]);
    speaker.stopAll();
  });

  it("plays out as the huddle stops everything else", () => {
    const speaker = huddleSpeaker("");
    const [sound, voice] = [audio(), audio()];
    speaker.play(voice);
    speaker.playOnce(sound);
    speaker.stopAll();
    expect(pause.mock.contexts).toEqual([voice]);

    // As the huddle's last sound does, which is played once the huddle has stopped.
    speaker.playOnce(sound);
    expect(play.mock.contexts).toEqual([voice, sound, sound]);
  });
});

describe("Another speaker chosen for a huddle", () => {
  it("plays what the huddle plays now, and what it plays after, until the system's is chosen again", async () => {
    const setSinkId = choosesSpeakers();
    const speaker = huddleSpeaker("");
    const [voice, later, sound] = [audio(), audio(), audio()];
    speaker.play(voice);
    expect(setSinkId).not.toHaveBeenCalled();

    const used = speaker.use("headphones");
    expect(setSinkId.mock.calls).toEqual([["headphones"]]);
    speaker.play(later);
    speaker.playOnce(sound);
    expect(setSinkId.mock.calls).toEqual([["headphones"], ["headphones"], ["headphones"]]);
    expect(setSinkId.mock.contexts).toEqual([voice, later, sound]);

    // With nothing under way, the browser is asked as it's chosen.
    await used;
    setSinkId.mockClear();
    speaker.use("");
    expect(setSinkId.mock.calls).toEqual([[""], [""]]);
    expect(setSinkId.mock.contexts).toEqual([voice, later]);
    speaker.playOnce(sound);
    expect(setSinkId.mock.calls).toEqual([[""], [""], [""]]);
    speaker.stopAll();
  });

  it("answers that the huddle plays through it once the browser does, and at once with nothing playing, or in a browser that can't choose a speaker", async () => {
    const speaker = huddleSpeaker("");
    speaker.play(audio());
    await expect(speaker.use("headphones")).resolves.toBe(true);

    const setSinkId = choosesSpeakers();
    await expect(speaker.use("monitor")).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledExactlyOnceWith("monitor");
    speaker.stopAll();
    const idle = huddleSpeaker("");
    await expect(idle.use("headphones")).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledOnce();
    idle.stopAll();
  });

  it("leaves the huddle on the one before when the browser won't play through it, and says so", async () => {
    const setSinkId = choosesSpeakers({ refused: ["broken"] });
    const changeTo = lists("default", "headphones", "broken");
    const speaker = huddleSpeaker("");
    const [voice, later] = [audio(), audio()];
    speaker.play(voice);
    await expect(speaker.use("headphones")).resolves.toBe(true);
    setSinkId.mockClear();

    await expect(speaker.use("broken")).resolves.toBe(false);
    expect(setSinkId.mock.calls).toEqual([["broken"], ["headphones"]]);
    expect(setSinkId.mock.contexts).toEqual([voice, voice]);
    // What it plays after goes through the one before, which is the one it follows as it's unplugged.
    speaker.play(later);
    expect(setSinkId.mock.calls).toEqual([["broken"], ["headphones"], ["headphones"]]);
    await changeTo("default", "broken");
    expect(setSinkId.mock.calls.slice(3)).toEqual([[""], [""]]);
    speaker.stopAll();
  });

  it("waits, chosen while the browser takes up another, for that one, so the last chosen is the one the huddle is left on", async () => {
    const setSinkId = choosesSpeakers({ slow: "headphones" });
    const speaker = huddleSpeaker("");
    const voice = audio();
    speaker.play(voice);

    const first = speaker.use("headphones");
    const last = speaker.use("monitor");
    await settled();
    // Asked for both at once, the browser would take up the monitor first, and leave the huddle on the headphones.
    expect(setSinkId.mock.calls).toEqual([["headphones"]]);
    setSinkId.take();
    await expect(first).resolves.toBe(true);
    await expect(last).resolves.toBe(true);
    expect(setSinkId.mock.calls).toEqual([["headphones"], ["monitor"]]);
    expect(voice.sinkId).toBe("monitor");
    speaker.stopAll();
  });

  it("waits as well, chosen while the browser refuses another, for the huddle to be back on the one before", async () => {
    const setSinkId = choosesSpeakers({ refused: ["broken"], slow: "headphones" });
    const speaker = huddleSpeaker("headphones");
    speaker.play(audio());

    const refused = speaker.use("broken");
    const taken = speaker.use("monitor");
    await settled();
    expect(setSinkId.mock.calls).toEqual([["headphones"], ["broken"], ["headphones"]]);
    setSinkId.take();
    await expect(refused).resolves.toBe(false);
    await expect(taken).resolves.toBe(true);
    expect(setSinkId.mock.calls.slice(3)).toEqual([["monitor"]]);
    speaker.stopAll();
  });

  it("goes back to the last the browser played through when it refuses two chosen one right after the other", async () => {
    const setSinkId = choosesSpeakers({ refused: ["broken", "unplugged"] });
    const speaker = huddleSpeaker("");
    const [voice, later] = [audio(), audio()];
    speaker.play(voice);
    await speaker.use("headphones");
    setSinkId.mockClear();

    await expect(Promise.all([speaker.use("broken"), speaker.use("unplugged")])).resolves.toEqual([false, false]);
    expect(setSinkId.mock.calls).toEqual([["broken"], ["headphones"], ["unplugged"], ["headphones"]]);
    // What it plays after goes through the one it's on, and not through one of those refused.
    speaker.play(later);
    expect(setSinkId.mock.calls.slice(4)).toEqual([["headphones"]]);
    expect(setSinkId.mock.contexts.at(-1)).toBe(later);
    speaker.stopAll();
  });

  it("gives way to the system's speaker for as long as it's unplugged, where the one the huddle began with is nothing to it now", async () => {
    const setSinkId = choosesSpeakers();
    const changeTo = lists("default", "headphones", "monitor");
    const speaker = huddleSpeaker("headphones");
    speaker.play(audio());
    speaker.use("monitor");
    setSinkId.mockClear();

    await changeTo("default", "monitor");
    expect(setSinkId.mock.calls).toEqual([["monitor"]]);
    await changeTo("default");
    expect(setSinkId.mock.calls).toEqual([["monitor"], [""]]);
    await changeTo("default", "monitor");
    expect(setSinkId.mock.calls).toEqual([["monitor"], [""], ["monitor"]]);
    speaker.stopAll();
  });

  it("is followed as it's unplugged by a huddle that began on the system's speaker, which asked nothing of the browser's speakers", async () => {
    const setSinkId = choosesSpeakers();
    const changeTo = lists("default", "headphones");
    const speaker = huddleSpeaker("");
    speaker.play(audio());
    await changeTo("default", "headphones");
    expect(setSinkId).not.toHaveBeenCalled();

    speaker.use("headphones");
    await changeTo("default");
    expect(setSinkId.mock.calls).toEqual([["headphones"], [""]]);
    speaker.stopAll();
  });

  it("is the one played through when it's chosen while the browser says whether the one before is there still", async () => {
    const setSinkId = choosesSpeakers();
    const changeTo = lists("default", "headphones", "monitor");
    const speaker = huddleSpeaker("headphones");
    speaker.play(audio());

    // The one before is unplugged, and another chosen before the browser has listed what's left.
    const listed = changeTo("default", "monitor");
    speaker.use("monitor");
    await listed;
    expect(setSinkId.mock.calls).toEqual([["headphones"], ["monitor"]]);
    speaker.stopAll();
  });
});

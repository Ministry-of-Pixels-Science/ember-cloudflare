import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { huddleSpeaker } from "./huddle-speaker";

/** Once what the speaker started has run as far as it goes without the browser. */
const settled = () => new Promise((resolve) => setTimeout(resolve));
const audio = () => document.createElement("audio");
const box = () => document.querySelector<HTMLElement>("[data-huddle-voices]");

/** A browser that can choose a speaker, as Safari can't: each `<audio>` says the one it was last told to play through. */
function choosesSpeakers() {
  const setSinkId = vi.fn(async function (this: HTMLMediaElement, deviceId: string) {
    Object.defineProperty(this, "sinkId", { configurable: true, value: deviceId });
  });
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
  return setSinkId;
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

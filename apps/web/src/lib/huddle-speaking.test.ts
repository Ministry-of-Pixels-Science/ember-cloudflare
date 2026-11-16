import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioEngine } from "@/test-audio-engine";
import { MEASURED_EVERY_MS, QUIET_FOR_MS, SPEAKING_LEVEL, whoSpeaks, type HuddleSpeaking } from "./huddle-speaking";

/** A voice's track, as much of one as is measured: jsdom has none. */
const voice = () => ({}) as MediaStreamTrack;
/** Stands in for the browser's MediaStream, which jsdom has none of. */
class FakeStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
  getAudioTracks = () => this.tracks;
}

/** As loud as someone speaking, and as someone who isn't. */
const [LOUD, QUIET] = [SPEAKING_LEVEL * 2, SPEAKING_LEVEL / 2];
const measures = (count = 1) => vi.advanceTimersByTime(count * MEASURED_EVERY_MS);

/** What a test measures voices with, which is stopped after it. */
let speaking: HuddleSpeaking;
/** Who was speaking each time that changed, in order. */
let said: string[][];
const measuring = () => (speaking = whoSpeaks((who) => said.push([...who])));

beforeEach(() => {
  said = [];
  vi.stubGlobal("MediaStream", FakeStream);
  vi.useFakeTimers();
});

afterEach(() => {
  speaking.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Who's speaking in a huddle", () => {
  it("is whoever's voice is as loud as speech when it's next measured", () => {
    const engine = audioEngine();
    const [sam, priya] = [voice(), voice()];
    measuring().hear("sam", sam);
    speaking.hear("priya", priya);
    engine.setLevel(sam, LOUD);
    engine.setLevel(priya, QUIET);
    expect(said).toEqual([]);

    measures();
    expect(said).toEqual([["sam"]]);
    engine.setLevel(priya, LOUD);
    measures();
    expect(said).toEqual([["sam"], ["sam", "priya"]]);
  });

  it("says so once, however long they speak", () => {
    const engine = audioEngine();
    const sam = voice();
    measuring().hear("sam", sam);
    engine.setLevel(sam, LOUD);
    measures(20);
    expect(said).toEqual([["sam"]]);
  });

  it("goes on being someone who has gone quiet, through the gaps between their words, and no longer once they've been quiet a while", () => {
    const engine = audioEngine();
    const sam = voice();
    measuring().hear("sam", sam);
    engine.setLevel(sam, LOUD);
    measures();
    engine.setLevel(sam, 0);

    vi.advanceTimersByTime(QUIET_FOR_MS - MEASURED_EVERY_MS);
    expect(said).toEqual([["sam"]]);
    // A word within that keeps them speaking as long again.
    engine.setLevel(sam, LOUD);
    measures();
    engine.setLevel(sam, 0);
    vi.advanceTimersByTime(QUIET_FOR_MS - MEASURED_EVERY_MS);
    expect(said).toEqual([["sam"]]);

    measures();
    expect(said).toEqual([["sam"], []]);
  });

  it("measures someone's next voice in place of the one it measured as theirs", () => {
    const engine = audioEngine();
    const [first, next] = [voice(), voice()];
    measuring().hear("sam", first);
    speaking.hear("sam", next);
    expect(engine.measured()).toEqual([next]);

    engine.setLevel(first, LOUD);
    measures();
    expect(said).toEqual([]);
    engine.setLevel(next, LOUD);
    measures();
    expect(said).toEqual([["sam"]]);
  });

  it("is nobody whose voice it has been told to forget, from when it next measures", () => {
    const engine = audioEngine();
    const [sam, priya] = [voice(), voice()];
    measuring().hear("sam", sam);
    speaking.hear("priya", priya);
    engine.setLevel(sam, LOUD);
    engine.setLevel(priya, LOUD);
    measures();

    speaking.forget("sam");
    expect(engine.measured()).toEqual([priya]);
    measures();
    expect(said).toEqual([["sam", "priya"], ["priya"]]);
    // Forgetting someone it doesn't measure is nothing.
    expect(() => speaking.forget("ada")).not.toThrow();
  });

  it("starts the browser's audio engine as it begins, one for every voice, and closes it as it stops, measuring nothing after", () => {
    const engine = audioEngine();
    measuring();
    expect(engine.engines.map(({ state }) => state)).toEqual(["running"]);

    const [sam, priya] = [voice(), voice()];
    speaking.hear("sam", sam);
    speaking.hear("priya", priya);
    expect(engine.engines).toHaveLength(1);
    expect(engine.measured()).toEqual([sam, priya]);

    engine.setLevel(sam, LOUD);
    speaking.stop();
    expect(engine.engines.map(({ state }) => state)).toEqual(["closed"]);
    expect(engine.measured()).toEqual([]);
    speaking.hear("sam", sam);
    measures(10);
    expect(engine.engines).toHaveLength(1);
    expect(engine.measured()).toEqual([]);
    expect(said).toEqual([]);
  });

  it("is nobody for long once the browser stops its audio engine, whose analysers keep what they last heard", () => {
    const engine = audioEngine();
    const sam = voice();
    measuring().hear("sam", sam);
    engine.setLevel(sam, LOUD);
    measures();
    engine.engines[0]!.state = "suspended";

    vi.advanceTimersByTime(QUIET_FOR_MS - MEASURED_EVERY_MS);
    expect(said).toEqual([["sam"]]);
    measures();
    expect(said).toEqual([["sam"], []]);
  });

  it("isn't someone who went quiet while the engine was stopped, by what its analysers still hold of them as it runs again", () => {
    const engine = audioEngine();
    const sam = voice();
    measuring().hear("sam", sam);
    engine.setLevel(sam, LOUD);
    measures();
    engine.engines[0]!.state = "suspended";
    vi.advanceTimersByTime(QUIET_FOR_MS);
    engine.setLevel(sam, 0);
    expect(said).toEqual([["sam"], []]);

    engine.engines[0]!.state = "running";
    measures(10);
    expect(said).toEqual([["sam"], []]);
  });

  it("hears who's speaking again once the engine has run for twice as long as its analysers hold, which is 171 ms at the tests' engine's 48 kHz", () => {
    const engine = audioEngine();
    const sam = voice();
    measuring().hear("sam", sam);
    engine.engines[0]!.state = "suspended";
    measures();
    engine.setLevel(sam, LOUD);

    engine.engines[0]!.state = "running";
    measures(3);
    expect(said).toEqual([]);
    measures();
    expect(said).toEqual([["sam"]]);
  });

  it.each(["click", "keydown"])("has an engine the browser keeps from running run at the person's next %s, from when it hears who's speaking", (touch) => {
    const engine = audioEngine("suspended");
    const sam = voice();
    measuring().hear("sam", sam);
    engine.setLevel(sam, LOUD);
    measures(5);
    expect(said).toEqual([]);

    document.body.dispatchEvent(new Event(touch, { bubbles: true }));
    expect(engine.engines.map(({ state }) => state)).toEqual(["running"]);
    measures(4);
    expect(said).toEqual([["sam"]]);
  });

  it("asks nothing more of an engine that runs, or of one it has closed, at a click", () => {
    const engine = audioEngine();
    measuring().hear("sam", voice());
    const [started] = engine.engines as unknown as AudioContext[];
    const resume = vi.spyOn(started!, "resume");
    document.body.click();
    speaking.stop();
    document.body.click();
    expect(resume).not.toHaveBeenCalled();
  });

  it("is nobody in a browser without an audio engine, or one that won't start it, or won't measure a voice with it", () => {
    // jsdom's, which has none.
    measuring().hear("sam", voice());
    measures(5);
    expect(said).toEqual([]);
    speaking.stop();

    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new DOMException("The browser has as many audio engines as it runs", "NotSupportedError");
        }
      },
    );
    expect(() => measuring().hear("sam", voice())).not.toThrow();
    speaking.stop();

    const engine = audioEngine();
    vi.spyOn(AudioContext.prototype, "createMediaStreamSource").mockImplementation(() => {
      throw new DOMException("The stream has no audio track", "InvalidStateError");
    });
    expect(() => measuring().hear("sam", voice())).not.toThrow();
    expect(engine.measured()).toEqual([]);
    measures(5);
    expect(said).toEqual([]);
  });
});

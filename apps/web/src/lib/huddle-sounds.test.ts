import { ALL_HUDDLE_SOUNDS, type HuddleSounds } from "@ember/protocol/huddles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_AFTER_MS } from "./huddle-sounds";
import type { HuddleSpeaker } from "./huddle-speaker";

/** Stands in for the huddle's speaker, which plays nothing here: the tests say what it was asked to play. */
const speaker = { play: vi.fn<HuddleSpeaker["play"]>(), stop: vi.fn<HuddleSpeaker["stop"]>(), playOnce: vi.fn<HuddleSpeaker["playOnce"]>(), use: vi.fn(), stopAll: vi.fn() } satisfies HuddleSpeaker;

const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settled = () => wait(0);

/** A sound's file, as the server answers with it. */
const theFile = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as Response;
/** The files the page has fetched, by name, in order. */
let fetched: string[];
/** How the server answers for the file of that name: with it, unless a test says otherwise. */
let answer: (name: string) => Promise<Response>;

/** Holds the answer for `name`'s file until the test gives it to the function returned. */
function hold(name: string) {
  let give!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => (give = resolve));
  answer = (asked) => (asked === name ? held : theFile());
  return give;
}

/** The huddle's sounds in a page that has fetched none of them yet. */
const inNewPage = async () => (await import("./huddle-sounds")).huddleSounds;
/** One huddle's sounds, as that page gives them. */
type Sounds = ReturnType<Awaited<ReturnType<typeof inNewPage>>>;

/** Has the tab's person hear every sound of a huddle but those `off` turns off, as the page does once their profile's switches say so, in the page `inNewPage` gives. */
const hear = async (off: Partial<HuddleSounds> = {}) => (await import("./huddle-store")).hearSounds({ ...ALL_HUDDLE_SOUNDS, ...off });

/** What the speaker was asked to play in that way: each sound's name, and the address it plays from. */
const asked = (to: "play" | "playOnce") => speaker[to].mock.calls.map(([audio]) => [audio.dataset.huddleSound, audio.src]);

beforeEach(() => {
  // The page keeps what it has fetched, so each test starts with a page of its own.
  vi.resetModules();
  vi.useFakeTimers();
  fetched = [];
  answer = theFile;
  vi.stubGlobal("fetch", (url: string) => {
    const name = new URL(url, location.href).pathname.split("/").at(-1)!;
    fetched.push(name);
    return answer(name);
  });
  let copies = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:copy-${++copies}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("The sounds of joining and leaving a huddle", () => {
  it("are fetched as the huddle is joined, and each plays once from the browser's own copy of its file", async () => {
    const sounds = (await inNewPage())(speaker);
    expect(fetched).toEqual(["joined.mp3", "left.mp3"]);

    sounds.joined();
    await settled();
    expect(asked("playOnce")).toEqual([["joined", "blob:copy-1"]]);
    sounds.left();
    sounds.joined();
    await settled();
    expect(asked("playOnce").slice(1)).toEqual([
      ["left", "blob:copy-2"],
      ["joined", "blob:copy-1"],
    ]);
    // Nobody was alone, so no music was fetched or played.
    await wait(MUSIC_AFTER_MS * 2);
    expect(fetched).toHaveLength(2);
    expect(speaker.play).not.toHaveBeenCalled();
  });

  it("are fetched once a page, however many huddles play them", async () => {
    const huddleSounds = await inNewPage();
    for (const sounds of [huddleSounds(speaker), huddleSounds(speaker)]) {
      sounds.joined();
      sounds.setAlone(true);
      await wait(MUSIC_AFTER_MS);
      sounds.left();
      await settled();
    }
    expect(fetched).toEqual(["joined.mp3", "left.mp3", "music.mp3"]);
    expect(asked("playOnce")).toEqual([
      ["joined", "blob:copy-1"],
      ["left", "blob:copy-2"],
      ["joined", "blob:copy-1"],
      ["left", "blob:copy-2"],
    ]);
    // Each huddle has its own `<audio>` of a sound, which plays the one copy.
    const [first, , second] = speaker.playOnce.mock.calls;
    expect(second![0]).not.toBe(first![0]);
  });

  it("play as soon as their files have come, when they're due before then", async () => {
    const give = hold("joined.mp3");
    const sounds = (await inNewPage())(speaker);
    sounds.joined();
    await settled();
    expect(speaker.playOnce).not.toHaveBeenCalled();

    give(await theFile());
    await settled();
    expect(asked("playOnce")).toEqual([["joined", "blob:copy-2"]]);
  });

  it.each([
    ["the server has no file", async () => ({ ok: false, status: 404 }) as Response],
    ["the network is down", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("go unplayed when %s, and are fetched again the next time they're due", async (_, failing) => {
    answer = failing;
    const sounds = (await inNewPage())(speaker);
    sounds.left();
    await settled();
    expect(speaker.playOnce).not.toHaveBeenCalled();
    expect(fetched).toEqual(["joined.mp3", "left.mp3"]);

    answer = theFile;
    sounds.left();
    await settled();
    expect(fetched).toEqual(["joined.mp3", "left.mp3", "left.mp3"]);
    expect(asked("playOnce")).toEqual([["left", "blob:copy-1"]]);
  });

  it("go unplayed when their files come once the huddle has ended, which only the sound of leaving it outlasts", async () => {
    const give = hold("joined.mp3");
    const sounds = (await inNewPage())(speaker);
    sounds.joined();
    sounds.end(true);
    await settled();
    expect(asked("playOnce")).toEqual([["left", "blob:copy-1"]]);

    // Played now, it would be heard after the huddle, or in the next.
    give(await theFile());
    await settled();
    expect(speaker.playOnce).toHaveBeenCalledTimes(1);
  });

  it("play the sound of leaving once, as its file comes, for a tab that left after someone else did", async () => {
    const give = hold("left.mp3");
    const sounds = (await inNewPage())(speaker);
    sounds.left();
    sounds.end(true);
    await settled();
    expect(speaker.playOnce).not.toHaveBeenCalled();

    give(await theFile());
    await settled();
    expect(asked("playOnce")).toEqual([["left", "blob:copy-2"]]);
  });

  it("play nothing as the huddle ends for a tab the room never let in", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.end(false);
    await settled();
    expect(speaker.playOnce).not.toHaveBeenCalled();
  });
});

describe("A huddle's music", () => {
  it("starts, on a loop, once its person has been alone for five seconds", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    // Fetched while they wait.
    expect(fetched).toEqual(["joined.mp3", "left.mp3", "music.mp3"]);
    await wait(MUSIC_AFTER_MS - 1);
    expect(speaker.play).not.toHaveBeenCalled();

    await wait(1);
    expect(asked("play")).toEqual([["music", "blob:copy-3"]]);
    expect(speaker.play.mock.calls[0]![0].loop).toBe(true);
    // It plays until it's stopped, where the other two play once.
    expect(speaker.playOnce).not.toHaveBeenCalled();
  });

  it("doesn't start for someone joined within the five seconds, and stops for whoever is joined after them", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS - 1);
    sounds.setAlone(false);
    await wait(MUSIC_AFTER_MS);
    expect(speaker.play).not.toHaveBeenCalled();

    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    const music = speaker.play.mock.calls[0]![0];
    speaker.stop.mockClear();
    sounds.setAlone(false);
    expect(speaker.stop).toHaveBeenCalledExactlyOnceWith(music);

    // The same `<audio>` plays again, and so goes on from where it stopped.
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    expect(speaker.play.mock.calls).toEqual([[music], [music]]);
  });

  it("counts the five seconds from when its person found themselves alone, whatever else changes meanwhile", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS - 1);
    sounds.setAlone(true);
    await wait(1);
    expect(speaker.play).toHaveBeenCalledTimes(1);

    // Told so again as it plays, it plays on.
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    expect(speaker.play).toHaveBeenCalledTimes(1);
    expect(speaker.stop).not.toHaveBeenCalled();
  });

  it("starts as its file comes when that takes longer than the five seconds", async () => {
    const give = hold("music.mp3");
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS * 2);
    expect(speaker.play).not.toHaveBeenCalled();

    give(await theFile());
    await settled();
    expect(asked("play")).toEqual([["music", "blob:copy-3"]]);
  });

  it("doesn't start as its file comes for someone who has been joined since, even if they're alone again", async () => {
    const give = hold("music.mp3");
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    sounds.setAlone(false);
    sounds.setAlone(true);
    give(await theFile());
    await wait(MUSIC_AFTER_MS - 1);
    expect(speaker.play).not.toHaveBeenCalled();

    await wait(1);
    expect(speaker.play).toHaveBeenCalledTimes(1);
  });

  it("stops as the huddle ends, and doesn't start for someone whose huddle ended within the five seconds", async () => {
    const huddleSounds = await inNewPage();
    const sounds = huddleSounds(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    const music = speaker.play.mock.calls[0]![0];
    sounds.end(true);
    expect(speaker.stop).toHaveBeenCalledExactlyOnceWith(music);

    const next = huddleSounds(speaker);
    next.setAlone(true);
    await wait(MUSIC_AFTER_MS - 1);
    next.end(true);
    await wait(MUSIC_AFTER_MS);
    expect(speaker.play).toHaveBeenCalledTimes(1);
  });

  it("stays silent when its file can't be fetched, which is tried again the next time someone is alone", async () => {
    answer = async (name) => (name === "music.mp3" ? Promise.reject(new TypeError("Failed to fetch")) : theFile());
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS * 2);
    expect(speaker.play).not.toHaveBeenCalled();

    answer = theFile;
    sounds.setAlone(false);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    expect(fetched).toEqual(["joined.mp3", "left.mp3", "music.mp3", "music.mp3"]);
    expect(speaker.play).toHaveBeenCalledTimes(1);
  });
});

describe("A huddle's sounds for someone who has turned some off", () => {
  it("plays no sound of someone joining or leaving, their own leaving included, to someone who has turned them off, and fetches neither", async () => {
    await hear({ chimes: false });
    const sounds = (await inNewPage())(speaker);
    sounds.joined();
    sounds.left();
    await settled();
    expect(fetched).toEqual([]);

    // Its music is another sound, which they still hear.
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    expect(asked("play")).toEqual([["music", "blob:copy-1"]]);
    sounds.end(true);
    await settled();
    expect(speaker.playOnce).not.toHaveBeenCalled();
    expect(fetched).toEqual(["music.mp3"]);
  });

  it("goes by which they hear at the time: turned on in a huddle, each sound is fetched as it's first due and plays from then, and turned off, plays no more", async () => {
    await hear({ chimes: false });
    const sounds = (await inNewPage())(speaker);
    sounds.joined();
    await hear();
    await settled();
    expect(fetched).toEqual([]);
    expect(speaker.playOnce).not.toHaveBeenCalled();

    sounds.joined();
    await settled();
    expect(fetched).toEqual(["joined.mp3"]);
    expect(asked("playOnce")).toEqual([["joined", "blob:copy-1"]]);

    await hear({ chimes: false });
    sounds.left();
    sounds.joined();
    sounds.end(true);
    await settled();
    expect(speaker.playOnce).toHaveBeenCalledTimes(1);
    expect(fetched).toEqual(["joined.mp3"]);
  });

  it.each([
    ["someone joining", "joined.mp3", (sounds: Sounds) => sounds.joined()],
    ["someone leaving", "left.mp3", (sounds: Sounds) => sounds.left()],
    ["their own leaving", "left.mp3", (sounds: Sounds) => sounds.end(true)],
  ] as const)("plays no sound of %s whose file comes once they've turned such sounds off, though it was due while they heard them", async (_, file, due) => {
    const give = hold(file);
    const sounds = (await inNewPage())(speaker);
    due(sounds);
    await hear({ chimes: false });
    give(await theFile());
    await settled();
    expect(speaker.playOnce).not.toHaveBeenCalled();
  });

  it("plays a sound whose file comes once they've turned such sounds back on", async () => {
    const give = hold("joined.mp3");
    const sounds = (await inNewPage())(speaker);
    sounds.joined();
    await hear({ chimes: false });
    await hear();
    give(await theFile());
    await settled();
    expect(asked("playOnce")).toEqual([["joined", "blob:copy-2"]]);
  });

  it("neither starts nor fetches its music for someone who has turned it off, however long they're alone", async () => {
    await hear({ music: false });
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS * 2);
    expect(speaker.play).not.toHaveBeenCalled();
    expect(fetched).toEqual(["joined.mp3", "left.mp3"]);

    // The sounds of joining and leaving are others, which they still hear.
    sounds.joined();
    await settled();
    expect(asked("playOnce")).toEqual([["joined", "blob:copy-1"]]);
  });

  it("stops its music as soon as they turn it off, and starts it five seconds after they turn it back on, as if they had just found themselves alone", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS);
    const music = speaker.play.mock.calls[0]![0];
    speaker.stop.mockClear();
    await hear({ music: false });
    expect(speaker.stop).toHaveBeenCalledExactlyOnceWith(music);

    await hear();
    await wait(MUSIC_AFTER_MS - 1);
    expect(speaker.play).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(speaker.play.mock.calls).toEqual([[music], [music]]);
  });

  it("doesn't start its music for someone who turns it off within the five seconds, nor for someone who turns it on while they aren't alone", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS - 1);
    await hear({ music: false });
    await wait(MUSIC_AFTER_MS);
    expect(speaker.play).not.toHaveBeenCalled();

    sounds.setAlone(false);
    await hear();
    await wait(MUSIC_AFTER_MS * 2);
    expect(speaker.play).not.toHaveBeenCalled();
    // Alone again, they wait the five seconds from then.
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS - 1);
    expect(speaker.play).not.toHaveBeenCalled();
    await wait(1);
    expect(speaker.play).toHaveBeenCalledTimes(1);
  });

  it("leaves its music as it is when they turn another sound on or off, waiting or playing", async () => {
    const sounds = (await inNewPage())(speaker);
    sounds.setAlone(true);
    await wait(MUSIC_AFTER_MS - 1);
    await hear({ ring: false });
    await hear({ ring: false, chimes: false });
    await wait(1);
    expect(speaker.play).toHaveBeenCalledTimes(1);

    await hear({ chimes: false });
    await hear();
    await wait(MUSIC_AFTER_MS);
    expect(speaker.play).toHaveBeenCalledTimes(1);
    expect(speaker.stop).not.toHaveBeenCalled();
  });

  it("stops following which they hear once the huddle has ended", async () => {
    const store = await import("./huddle-store");
    const watch = store.watchHeardSounds;
    let following = 0;
    vi.spyOn(store, "watchHeardSounds").mockImplementation((listener) => {
      following++;
      const unwatch = watch(listener);
      return () => {
        following--;
        unwatch();
      };
    });
    const huddleSounds = await inNewPage();
    const [first, second] = [huddleSounds(speaker), huddleSounds(speaker)];
    expect(following).toBe(2);
    first.end(true);
    expect(following).toBe(1);
    second.end(false);
    expect(following).toBe(0);
  });
});

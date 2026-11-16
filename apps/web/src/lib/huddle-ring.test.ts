import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The `<audio>`s the page has played, in order, and the ones it has paused. */
let played: HTMLAudioElement[];
let paused: HTMLAudioElement[];
/** Whether the browser lets the page play a sound, as it doesn't in a tab nobody has touched. */
let letPlay: boolean;
/** The files the page has fetched, by name, in order. */
let fetched: string[];
/** How the server answers for a sound's file: with it, unless a test says otherwise. */
let answer: () => Promise<Response>;

const theFile = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as Response;
const settled = () => new Promise((resolve) => setTimeout(resolve));

/**
 * The locks the tabs of a browser share, as much of them as a ring asks for: one tab holds a lock at a
 * time, the rest wait their turn in the order they asked, and one that stops waiting is refused.
 */
class FakeLocks {
  private held = false;
  /** Those waiting their turn, in the order they asked. */
  waiting: (() => void)[] = [];
  /** The names of the locks asked for. */
  asked: string[] = [];

  request = async (name: string, { signal }: { signal: AbortSignal }, callback: () => Promise<void>) => {
    this.asked.push(name);
    if (this.held) {
      await new Promise<void>((turn, refuse) => {
        this.waiting.push(turn);
        signal.addEventListener("abort", () => {
          this.waiting = this.waiting.filter((waiter) => waiter !== turn);
          refuse(new DOMException("The request was aborted.", "AbortError"));
        });
      });
    }
    this.held = true;
    try {
      await callback();
    } finally {
      this.held = false;
      this.waiting.shift()?.();
    }
  };
}

/** The ring of a page that has fetched no sound yet, and the name of the lock it rings by. */
const inNewPage = async () => await import("./huddle-ring");

beforeEach(() => {
  // The page keeps what it has fetched, so each test starts with a page of its own.
  vi.resetModules();
  [played, paused, fetched, letPlay, answer] = [[], [], [], true, theFile];
  vi.stubGlobal("fetch", (url: string) => {
    fetched.push(new URL(url, location.href).pathname.split("/").at(-1)!);
    return answer();
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:the-ring");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLAudioElement) {
    if (!letPlay) throw new DOMException("The page hasn't been touched.", "NotAllowedError");
    played.push(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLAudioElement) {
    paused.push(this);
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("The ring of an invitation into a huddle", () => {
  it("plays the invitation's sound over and over, from the browser's own copy of its file, until it's stopped", async () => {
    const { ringForHuddle } = await inNewPage();
    const stop = ringForHuddle();
    await settled();
    expect(fetched).toEqual(["invited.mp3"]);
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({ loop: true, src: "blob:the-ring" });
    expect(played[0]!.dataset.huddleSound).toBe("invited");
    expect(paused).toEqual([]);

    stop();
    await settled();
    expect(paused).toEqual(played);
  });

  it("plays nothing once it's stopped before its file has come", async () => {
    let give!: (response: Response) => void;
    answer = () => new Promise<Response>((resolve) => (give = resolve));
    const stop = (await inNewPage()).ringForHuddle();
    await settled();
    stop();
    give(await theFile());
    await settled();
    expect(played).toEqual([]);
  });

  it("rings nothing where its file can't be fetched, and fetches it again for the next", async () => {
    answer = async () => ({ ok: false, status: 503 }) as Response;
    const { ringForHuddle } = await inNewPage();
    ringForHuddle();
    await settled();
    expect(played).toEqual([]);

    answer = theFile;
    ringForHuddle();
    await settled();
    expect(fetched).toEqual(["invited.mp3", "invited.mp3"]);
    expect(played).toHaveLength(1);
  });
});

describe("The tabs of a browser", () => {
  let locks: FakeLocks;
  beforeEach(() => {
    locks = new FakeLocks();
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  });

  it("ring one at a time, by a lock they share, the next once the one ringing has stopped", async () => {
    const { ringForHuddle, RING_LOCK } = await inNewPage();
    const [stopFirst, stopSecond] = [ringForHuddle(), ringForHuddle()];
    await settled();
    expect(locks.asked).toEqual([RING_LOCK, RING_LOCK]);
    expect(played).toHaveLength(1);

    stopFirst();
    await settled();
    expect(paused).toEqual([played[0]]);
    expect(played).toHaveLength(2);

    stopSecond();
    await settled();
    expect(paused).toEqual(played);
  });

  it("wait their turn no longer once stopped before it, and never ring", async () => {
    const { ringForHuddle } = await inNewPage();
    const [stopFirst, stopSecond] = [ringForHuddle(), ringForHuddle()];
    await settled();
    expect(locks.waiting).toHaveLength(1);
    stopSecond();
    await settled();
    expect(locks.waiting).toEqual([]);
    stopFirst();
    await settled();
    expect(played).toHaveLength(1);
  });

  it("leave the ringing to the next when the browser won't let them play a sound", async () => {
    const { ringForHuddle } = await inNewPage();
    letPlay = false;
    ringForHuddle();
    await settled();
    letPlay = true;
    const stop = ringForHuddle();
    await settled();
    // The first holds no lock for a ring nobody hears, so the second rings without waiting for it to stop.
    expect(played).toHaveLength(1);
    stop();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { keepScreenAwake } from "./huddle-awake";

/** What a browser hands over for a screen it keeps awake, as much of it as the code reads. */
class FakeLock {
  released = false;
  release = vi.fn(async () => this.letGo());

  /** The browser lets the screen go, as it does by itself once the page is hidden. */
  letGo() {
    this.released = true;
  }
}

/**
 * Has the browser be a phone's that keeps its screen awake when it's asked to, or with `touch` false, a
 * computer's. Answers what it was asked, and what it handed over each time.
 */
function browser(touch = true) {
  const locks: FakeLock[] = [];
  const request = vi.fn(async (_what: string) => {
    const lock = new FakeLock();
    locks.push(lock);
    return lock;
  });
  vi.stubGlobal("navigator", { wakeLock: { request } });
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: touch && media === "(pointer: coarse)" }));
  return { request, locks };
}

const visibility = (state: DocumentVisibilityState) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

/** Once the browser has answered what it was asked. */
const answered = () => new Promise((resolve) => setTimeout(resolve));

// Each test's screen, let go of after it so it stops listening to the tab.
let letSleep: (() => void) | undefined;
const keepAwake = () => (letSleep = keepScreenAwake());

afterEach(() => {
  letSleep?.();
  letSleep = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Keeping a phone's screen awake", () => {
  it("asks the browser to at once, and lets the screen go once it's told to", async () => {
    const { request, locks } = browser();
    const stop = keepAwake();
    await answered();
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
    expect(locks[0]!.release).not.toHaveBeenCalled();

    stop();
    expect(locks[0]!.release).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of a computer's browser, whose screen sleeping stops nothing", async () => {
    const { request } = browser(false);
    keepAwake()();
    await answered();
    expect(request).not.toHaveBeenCalled();
  });

  it("asks nothing of a browser that can't keep a screen awake", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(() => keepAwake()()).not.toThrow();
  });

  it("asks again as the page shows again, the browser having let the screen go while it was hidden", async () => {
    const { request, locks } = browser();
    const stop = keepAwake();
    await answered();

    visibility("hidden");
    locks[0]!.letGo();
    await answered();
    expect(request).toHaveBeenCalledTimes(1);
    visibility("visible");
    await answered();
    expect(request).toHaveBeenCalledTimes(2);

    // What it lets go of is what it was last given.
    stop();
    expect(locks.map((lock) => lock.release.mock.calls.length)).toEqual([0, 1]);
  });

  it("asks for nothing as the page shows again with its screen still kept awake", async () => {
    const { request } = browser();
    keepAwake();
    await answered();
    visibility("hidden");
    visibility("visible");
    await answered();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits for a page that's hidden to show before it asks, as a browser refuses one that is", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { request } = browser();
    keepAwake();
    await answered();
    expect(request).not.toHaveBeenCalled();

    visibility("visible");
    await answered();
    expect(request).toHaveBeenCalledExactlyOnceWith("screen");
  });

  it("leaves the screen to lock where the browser won't keep it awake, and asks again the next time the page shows", async () => {
    const { request, locks } = browser();
    request.mockRejectedValueOnce(new DOMException("Low battery", "NotAllowedError"));
    const stop = keepAwake();
    await answered();
    expect(locks).toEqual([]);

    visibility("visible");
    await answered();
    expect(request).toHaveBeenCalledTimes(2);
    stop();
    expect(locks[0]!.release).toHaveBeenCalledTimes(1);
  });

  it("asks once while the browser has yet to answer", async () => {
    const { request } = browser();
    let answer = (_lock: FakeLock) => {};
    request.mockImplementationOnce(() => new Promise<FakeLock>((resolve) => (answer = resolve)));
    const stop = keepAwake();
    visibility("visible");
    visibility("visible");
    expect(request).toHaveBeenCalledTimes(1);

    const lock = new FakeLock();
    answer(lock);
    await answered();
    stop();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("lets go of a screen the browser keeps awake only once it's been told to let it go", async () => {
    const { request } = browser();
    let answer = (_lock: FakeLock) => {};
    request.mockImplementationOnce(() => new Promise<FakeLock>((resolve) => (answer = resolve)));
    keepAwake()();

    const lock = new FakeLock();
    answer(lock);
    await answered();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing more once it's told to let the screen go", async () => {
    const { request } = browser();
    const stop = keepAwake();
    await answered();
    stop();
    visibility("visible");
    await answered();
    expect(request).toHaveBeenCalledTimes(1);
  });

});
